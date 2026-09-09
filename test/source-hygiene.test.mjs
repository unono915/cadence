import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 소스 파일에 눈에 보이지 않는 문자가 섞이지 않았는지 본다.
 *
 * 실제로 한 번 섞였다. `categorize.mjs` 안에 NUL 바이트 두 개가 글자 그대로 박혀 있었다 —
 * 규칙의 열쇠를 만드는 구분자였는데, 소스에 맨 글자로 들어가 있었다.
 * 동작은 멀쩡했다. 문제는 그 순간부터 그 파일이 도구들에게 **바이너리**로 보였다는 것이다.
 * `grep` 은 "Binary file matches" 만 내놓고 내용을 보여 주지 않고, diff 도 마찬가지다.
 * 가장 손이 많이 가는 파일 하나가 조용히 검색과 리뷰 밖으로 빠져나가 있었다.
 *
 * 이런 것은 사람이 읽어서는 절대 찾지 못한다. 보이지 않기 때문이다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const EXTS = new Set(['.mjs', '.js', '.ps1', '.md', '.css', '.html', '.json', '.cmd']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'demo']);

function sourceFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) sourceFiles(path.join(dir, entry.name), out);
    } else if (EXTS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('소스에 제어문자가 글자 그대로 들어 있지 않다', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const buf = fs.readFileSync(file);
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      // 탭(9), 줄바꿈(10), 캐리지리턴(13) 은 정상이다.
      if (b === 9 || b === 10 || b === 13) continue;
      if (b < 32 || b === 127) {
        const line = buf.subarray(0, i).toString('utf8').split('\n').length;
        offenders.push(`${path.relative(ROOT, file)}:${line} — 0x${b.toString(16).padStart(2, '0')}`);
        break; // 파일당 한 번만 — 목록이 길어지면 오히려 안 읽힌다.
      }
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`
    + '\n  이스케이프(\\u0000 등)로 적으세요. 맨 글자로 두면 파일이 바이너리 취급됩니다.');
});

/**
 * UTF-8 로 읽히는지.
 *
 * 이 저장소는 주석도 화면 문구도 한국어다. 편집 도구가 한 번만 다른 인코딩으로 저장해도
 * 그 파일의 모든 설명이 깨진 글자가 되고, 되돌리려면 사람이 다시 쓰는 수밖에 없다.
 */
test('소스가 모두 UTF-8 로 읽힌다', () => {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const offenders = [];
  for (const file of sourceFiles()) {
    try {
      decoder.decode(fs.readFileSync(file));
    } catch {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `\n  UTF-8 이 아닙니다: ${offenders.join(', ')}`);
});

/**
 * BOM 이 붙지 않았는지.
 *
 * 윈도우의 여러 도구가 UTF-8 로 저장할 때 앞에 BOM 을 붙인다. `.ps1` 은 그래도 돌지만,
 * `.json` 은 `JSON.parse` 가 첫 글자에서 바로 실패하고, `.mjs` 는 파일 첫 줄이
 * `#!` 이거나 지시어일 때 조용히 어긋난다.
 */
test('소스에 BOM 이 붙어 있지 않다', () => {
  const offenders = [];
  for (const file of sourceFiles()) {
    const head = fs.readFileSync(file).subarray(0, 3);
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `\n  BOM 이 붙었습니다: ${offenders.join(', ')}`);
});
