import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { useTempData } from './helpers.mjs';

useTempData('limits');

const { LIMITS } = await import('../web/lib/limits.js');
const tasks = await import('../server/api/tasks.mjs');
const activity = await import('../server/api/activity.mjs');
const misc = await import('../server/api/misc.mjs');

/**
 * 입력 길이의 상한이 서버와 화면에서 **같은 숫자**인지 본다.
 *
 * 이건 정의 어긋남(definition drift)의 전형이다. 서버는 카테고리 이름을 마흔 자까지
 * 받는데 화면은 그걸 모르니, 사용자는 길게 다 쓰고 저장을 누른 뒤에야 빨간 오류를 봤다.
 * 숫자를 양쪽에 각각 적어 두면 언젠가 한쪽만 바뀌고, 그때는 아무도 알아채지 못한다.
 *
 * 그래서 `web/lib/limits.js` 한 군데서만 정하고 양쪽이 가져다 쓰기로 했다.
 * 이 검사는 그 약속이 지켜지는지를 본다 — 숫자를 다시 손으로 적어 넣는 순간 걸린다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const filesIn = (rel, ext) => fs.readdirSync(path.join(ROOT, rel))
  .filter((f) => f.endsWith(ext))
  .map((f) => `${rel}/${f}`);

// ---- 1) 서버가 정말 그 숫자에서 자르는지 ----

test('서버가 상한을 넘는 값을 거절하고, 딱 맞는 값은 받는다', () => {
  const cases = [
    ['태스크 제목', LIMITS.TASK_TITLE, (v) => tasks.createTask({ title: v })],
    ['태스크 메모', LIMITS.TASK_NOTES, (v) => tasks.createTask({ title: 'x', notes: v })],
    ['프로젝트 이름', LIMITS.PROJECT_NAME, (v) => tasks.createProject({ name: v })],
    ['카테고리 이름', LIMITS.CATEGORY_NAME, (v) => activity.createCategory({ name: v, kind: 'deep' })],
    ['빠른 메모', LIMITS.NOTE_LINE, (v) => misc.appendNote({ text: v })],
  ];

  for (const [label, max, call] of cases) {
    assert.ok(Number.isInteger(max) && max > 0, `${label}: 상한이 숫자가 아닙니다`);
    // 딱 맞는 길이는 통과해야 한다 — 경계에서 하나 어긋나면 아무도 모른 채 한 글자를 잃는다.
    assert.doesNotThrow(() => call('가'.repeat(max)), `${label}: ${max}자를 거절했습니다`);
    // 한 글자 넘으면 400.
    assert.throws(
      () => call('가'.repeat(max + 1)),
      (err) => err.status === 400,
      `${label}: ${max + 1}자를 그대로 받았습니다 — 상한이 지켜지지 않습니다`,
    );
  }
});

// ---- 2) 숫자를 다시 손으로 적어 넣지 않았는지 ----

/**
 * 이 검사가 없으면 다음에 새 필드를 만드는 사람은 그냥 `{ max: 300 }` 이라고 적는다.
 * 그게 자연스럽고, 그 순간에는 아무 문제도 없다 — 어긋나는 건 한참 뒤다.
 */
test('서버의 문자열 검사에 길이 숫자를 직접 적어 두지 않는다', () => {
  const offenders = [];
  // q(검색어)처럼 화면에 입력칸이 없는 내부 한계는 여기서 제외한다.
  const INTERNAL = new Set(['q']);

  for (const rel of [...filesIn('server/api', '.mjs'), ...filesIn('server/lib', '.mjs')]) {
    const src = read(rel);
    for (const [line, i] of src.split('\n').map((l, n) => [l, n + 1])) {
      const m = line.match(/str\(\s*\w+(?:\.\w+)*\s*,\s*'(\w+)'[^)]*max:\s*([0-9][0-9_]*)/);
      if (m && !INTERNAL.has(m[1])) offenders.push(`${rel}:${i} — ${m[1]} 에 ${m[2]} 를 직접 적었습니다`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n  web/lib/limits.js 의 값을 쓰세요.`);
});

// ---- 3) 화면의 입력칸이 상한을 알고 있는지 ----

/**
 * 서버 검사만으로는 부족하다. 서버는 거절할 뿐, **이미 다 쓴 뒤**에 거절한다.
 * 붙여넣기까지 막아 주는 것은 입력칸의 `maxlength` 뿐이다.
 *
 * 길이를 재지 않아도 되는 칸은 여기 적어 둔다 — 적는 행위가 곧 판단의 기록이 된다.
 * 빠뜨리면 걸리고, 일부러 뺐다면 이유가 남는다.
 */
const UNBOUNDED = new Map([
  ['web/views/activity-search.js', '기록을 걸러 보는 검색칸 — 저장되지 않는다'],
  ['web/views/tasks.js', '태스크 검색칸 — 저장되지 않는다'],
  ['web/views/palette.js', '명령 팔레트 검색칸 — 저장되지 않는다'],
  ['web/views/reports.js', '만들어진 마크다운을 보여 주는 칸 — 사람이 쓰는 곳이 아니다'],
  ['web/views/today.js:noteArea', '하루 노트 — 자동 저장되고 상한이 10만 자라 사실상 없다'],
  ['web/views/timeline.js:timeInput', 'HH:MM 한 칸 — 형식 검사가 따로 있다'],
]);

/** `start` 줄에서 시작하는 한 선언을, 괄호가 닫히는 곳까지만 잘라 온다. */
function declaration(lines, start) {
  let depth = 0;
  const out = [];
  for (let i = start; i < lines.length && i < start + 12; i++) {
    out.push(lines[i]);
    for (const ch of lines[i]) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
    }
    if (depth <= 0 && i > start - 1) break;
  }
  return out.join('\n');
}

test('화면의 글 입력칸은 모두 길이 상한을 알고 있다', () => {
  const offenders = [];
  for (const rel of filesIn('web/views', '.js')) {
    const src = read(rel);
    const lines = src.split('\n');
    for (const [i, line] of lines.entries()) {
      const isText = /h\('input',\s*\{[^}]*type:\s*'text'/.test(line)
        || /h\('input',\s*\{\s*$/.test(line) && /type:\s*'text'/.test(lines[i + 1] ?? '')
        || /h\('textarea'/.test(line);
      if (!isText) continue;
      // 선언은 여러 줄에 걸친다. **그 선언이 끝나는 곳까지만** 본다 —
      // 넉넉히 몇 줄 더 보면 바로 아래 다른 입력칸의 maxlength 를 제 것으로 착각한다.
      // (이 검사를 처음 만들었을 때 실제로 그렇게 새어서, 상한 없는 칸을 놓쳤다.)
      const block = declaration(lines, i);
      if (/maxlength:/.test(block)) continue;
      const varName = line.match(/const (\w+)\s*=/)?.[1];
      if (UNBOUNDED.has(rel) || (varName && UNBOUNDED.has(`${rel}:${varName}`))) continue;
      offenders.push(`${rel}:${i + 1} — ${line.trim().slice(0, 70)}`);
    }
  }
  assert.deepEqual(offenders, [], '\n  길이를 막지 않은 입력칸:\n  ' + offenders.join('\n  ')
    + '\n  maxlength: LIMITS.… 를 붙이거나, 이유와 함께 UNBOUNDED 에 적어 주세요.');
});

test('화면이 쓰는 상한은 모두 limits.js 에서 온다', () => {
  const offenders = [];
  for (const rel of [...filesIn('web/views', '.js'), ...filesIn('web/lib', '.js')]) {
    if (rel.endsWith('limits.js')) continue;
    for (const [line, i] of read(rel).split('\n').map((l, n) => [l, n + 1])) {
      const m = line.match(/maxlength:\s*([0-9][0-9_]*)/);
      if (m) offenders.push(`${rel}:${i} — maxlength 에 ${m[1]} 을 직접 적었습니다`);
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}`);
});
