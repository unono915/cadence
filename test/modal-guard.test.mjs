import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DismissGuard } from '../web/lib/ui.js';

/**
 * 실수로 모달을 닫아 쓰던 글을 잃지 않는지 본다.
 *
 * 이건 "불편하다" 가 아니라 "되돌릴 수 없다" 쪽의 문제다. 태스크 메모 칸은 8000자까지
 * 받고 하루 마무리 회고도 모달 안에서 쓰는데, 배경을 한 번 잘못 누르면 그게 통째로
 * 사라졌다. 실행 취소도, 임시 저장도 없었다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const UI_JS = path.join(here, '..', 'web', 'lib', 'ui.js');

test('쓰던 내용이 없으면 한 번에 닫힌다', () => {
  let warned = 0;
  const g = new DismissGuard(() => false, () => { warned++; });
  assert.equal(g.request(1000), true);
  assert.equal(g.request(2000), true);
  assert.equal(warned, 0, '아무것도 안 쓴 창까지 두 번 누르게 하면 그냥 성가신 도구가 된다');
});

test('쓰던 내용이 있으면 첫 번째는 막고 알린다', () => {
  const warns = [];
  const g = new DismissGuard(() => true, (ms) => warns.push(ms), 4000);
  assert.equal(g.request(1000), false, '첫 번째 누름에 닫히면 내용을 잃는다');
  assert.deepEqual(warns, [4000], '막았으면 왜 안 닫혔는지 반드시 말해 줘야 한다');
});

test('바로 이어서 한 번 더 누르면 닫힌다', () => {
  const g = new DismissGuard(() => true, () => {}, 4000);
  g.request(1000);
  assert.equal(g.request(1200), true, '작정하고 두 번 눌렀는데 안 닫히면 갇힌다');
});

test('시간이 지나면 다시 처음부터 — 한참 뒤의 한 번은 닫지 않는다', () => {
  const warns = [];
  const g = new DismissGuard(() => true, (ms) => warns.push(ms), 4000);
  g.request(1000);
  assert.equal(g.request(1000 + 4000), false, '경계에서는 아직 안 닫혀야 한다');
  assert.equal(g.request(1000 + 9999), false);
  assert.equal(warns.length, 3, '막을 때마다 알려야 한다 — 조용히 무시하면 고장으로 보인다');
});

test('알린 뒤에도 계속 쓰고 있었다면 다시 처음부터', () => {
  // 알림을 보고 "아 맞다" 하며 이어 쓰는 중에 손이 미끄러져 Esc 가 눌리는 상황.
  // 그때 열려 있던 창이 그대로 닫히면, 막아 준 의미가 없다.
  const g = new DismissGuard(() => true, () => {}, 4000);
  g.request(1000);
  g.disarm(); // 입력이 한 번 더 들어왔다
  assert.equal(g.request(1100), false);
});

test('쓰던 내용이 도로 원래대로 돌아오면 그냥 닫힌다', () => {
  let dirty = true;
  const g = new DismissGuard(() => dirty, () => {});
  assert.equal(g.request(1000), false);
  dirty = false; // 친 것을 다시 지웠다
  assert.equal(g.request(1100), true);
});

/**
 * 배선이 살아 있는지.
 *
 * 위 검사들은 판단 규칙만 본다. 규칙이 아무리 맞아도 `openModal()` 이 그걸 부르지 않으면
 * 아무것도 지켜지지 않는다 — 그리고 그 배선은 한 줄(`root.onclick = close`)만 되돌아가도
 * 조용히 사라진다. DOM 없이 확인할 수 있는 선에서 원문을 본다.
 */
test('모달의 배경 클릭과 Esc 가 곧바로 닫지 않는다', () => {
  const src = fs.readFileSync(UI_JS, 'utf8');
  assert.doesNotMatch(src, /root\.onclick\s*=\s*close\b/,
    '배경 클릭이 확인 없이 닫습니다 — 쓰던 글이 사라집니다');
  assert.match(src, /root\.onclick\s*=\s*requestClose\b/);
  assert.match(src, /'Escape'[\s\S]{0,80}requestClose\(\)/,
    'Esc 가 확인 없이 닫습니다');
  assert.match(src, /addEventListener\('input',\s*\(\)\s*=>\s*guard\.disarm\(\)\)/,
    '입력이 들어와도 다시 무장하지 않으면, 알린 직후의 실수를 막지 못합니다');
});
