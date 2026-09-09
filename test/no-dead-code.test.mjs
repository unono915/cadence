import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 쓰이지 않는 코드가 쌓이지 않게 한다.
 *
 * 이 프로젝트에는 외부에 공개하는 API 가 없다. 그러니 아무 데서도 부르지 않는 export 는
 * 예외 없이 남은 흔적이다 — 기능을 옮기다 만 것이거나, 쓰다 만 헬퍼이거나.
 * 그런 것들이 위험한 이유는 자리를 차지해서가 아니라 **읽는 사람을 속이기 때문**이다.
 * 실제로 이 코드베이스에서 아무도 쓰지 않는 `html:` 우회로가 XSS 통로로 남아 있었다.
 *
 * 사람이 리뷰로 잡기 어려운 종류라 검사에 맡긴다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const SOURCE_DIRS = ['server', 'web', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'demo', '.git']);

function collect(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return SKIP_DIRS.has(e.name) ? [] : collect(path.join(dir, e.name));
    return /\.(mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : [];
  });
}

const sourceFiles = SOURCE_DIRS.flatMap((d) => collect(path.join(ROOT, d)));
const testFiles = collect(here);
const read = (f) => fs.readFileSync(f, 'utf8');
const sources = new Map(sourceFiles.map((f) => [f, read(f)]));
const tests = new Map(testFiles.map((f) => [f, read(f)]));

const EXPORT_DECL = /^export\s+(?:async\s+)?(?:function|const|class|let)\s+([A-Za-z_$][\w$]*)/gm;
const NAMED_IMPORT = /^import\s+(?:([A-Za-z_$][\w$]*)\s*,\s*)?\{([^}]*)\}\s*from/gm;
const DEFAULT_IMPORT = /^import\s+([A-Za-z_$][\w$]*)\s+from/gm;

const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const count = (text, name) => (text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;

test('아무도 쓰지 않는 export 가 없다', () => {
  assert.ok(sourceFiles.length >= 20, `소스 파일이 ${sourceFiles.length}개뿐입니다 — 경로가 틀렸을 수 있습니다`);

  const dead = [];
  for (const [file, text] of sources) {
    for (const [decl, name] of text.matchAll(EXPORT_DECL)) {
      // 선언한 자리 자체는 세지 않는다.
      let uses = -count(decl, name);
      for (const other of sources.values()) uses += count(other, name);
      for (const other of tests.values()) uses += count(other, name);
      if (uses <= 0) dead.push(`${rel(file)}: ${name}`);
    }
  }
  assert.deepEqual(dead, [], `쓰이지 않는 export: ${dead.join(' | ')}`);
});

test('쓰지 않는 import 가 없다', () => {
  const unused = [];
  for (const [file, text] of [...sources, ...tests]) {
    const body = text.replace(NAMED_IMPORT, '').replace(DEFAULT_IMPORT, '');
    const names = [];
    for (const m of text.matchAll(NAMED_IMPORT)) {
      if (m[1]) names.push(m[1]);
      for (const part of m[2].split(',')) {
        const token = part.trim();
        if (token) names.push(token.includes(' as ') ? token.split(' as ').pop().trim() : token);
      }
    }
    for (const m of text.matchAll(DEFAULT_IMPORT)) names.push(m[1]);
    for (const name of names) {
      if (!count(body, name)) unused.push(`${rel(file)}: ${name}`);
    }
  }
  assert.deepEqual(unused, [], `쓰지 않는 import: ${unused.join(' | ')}`);
});

/**
 * 날짜 계산을 각자 따로 만들지 않는다.
 *
 * `format.js` 에 `shiftDay` 가 있는데도 화면 파일 네 곳이 같은 함수를 각자 들고 있었다.
 * 넷 다 자정을 기준으로 삼아, 자정이 존재하지 않는 서머타임 전환일에 날짜가 밀렸다 —
 * 공용 함수는 이미 정오 기준으로 고쳐 뒀는데도 사본들은 그대로였다.
 *
 * 이런 사본은 만들 때는 세 줄짜리 편의지만, 고칠 때는 어디에 몇 개가 있는지 아무도 모른다.
 */
test('날짜 계산 함수를 파일마다 따로 만들지 않는다', () => {
  const offenders = [];
  for (const file of collect(path.join(ROOT, 'web'))) {
    if (file.endsWith(path.join('lib', 'format.js'))) continue;
    const code = fs.readFileSync(file, 'utf8');
    // 사본의 표식: 'YYYY-MM-DD' 를 쪼개 날짜를 옮긴 뒤 **다시 키로 조립**하는 모양.
    // 시각(epoch)을 만드는 것은 사본이 아니므로, 키를 되돌려 만드는 쪽만 잡는다.
    const shifts = /new Date\(\s*y\s*,\s*m\s*-\s*1\s*,\s*d\s*[+-]/.test(code);
    const buildsKey = /getFullYear\(\)\}-/.test(code);
    if (shifts && buildsKey) offenders.push(path.relative(ROOT, file));
  }
  assert.deepEqual(offenders, [],
    `format.js 의 shiftDay 를 쓰세요 — 날짜 계산 사본: ${offenders.join(', ')}`);
});

/**
 * 브라우저가 읽는 파일이 문법적으로 성립하는지.
 *
 * `web/` 아래는 빌드 단계가 없다 — 브라우저가 그대로 읽는다. 그래서 문법 오류가 나도
 * 검사도 서버도 아무 말을 하지 않고, 화면을 열어야 비로소 빈 화면이 된다.
 * 게다가 그 파일 하나가 아니라 **그것을 부르는 화면 전체**가 죽는다.
 *
 * node 는 `.js` 를 CommonJS 로 읽으므로 import 구문에서 걸린다. 임시로 `.mjs` 로 옮겨
 * `node --check` 에 맡긴다 — 파서를 직접 만들 이유가 없다.
 */
test('브라우저가 읽는 파일이 모두 파싱된다', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');

  const files = collect(path.join(ROOT, 'web'));
  assert.ok(files.length >= 15, `검사할 파일이 ${files.length}개뿐입니다 — 경로가 틀렸을 수 있습니다`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-parse-'));
  const broken = [];
  try {
    for (const file of files) {
      const tmp = path.join(dir, 'check.mjs');
      fs.copyFileSync(file, tmp);
      const res = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
      if (res.status !== 0) {
        const why = (res.stderr || '').split('\n').find((l) => /Error/.test(l)) || '알 수 없는 오류';
        broken.push(`${path.relative(ROOT, file)}: ${why.trim()}`);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(broken, [], `문법 오류:\n  ${broken.join('\n  ')}`);
});
