import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { remembered, remember } from '../web/lib/store.js';

/**
 * 브라우저에 기억해 둔 선택이 화면을 망가뜨리지 않는지 본다.
 *
 * 리포트 화면의 '기간' 은 localStorage 에 남는다. 거기에 숫자가 아닌 것이 들어 있으면
 * 서버가 400 을 내고 화면은 통째로 "불러오지 못했습니다" 가 된다. 그 화면에 남는 것은
 * '다시 시도' 단추뿐인데, 눌러도 같은 값을 또 보내니 **영원히 같은 자리에 머문다.**
 * 실제로 그렇게 되는 것을 확인하고 고쳤다 — 브라우저 저장소를 직접 지우는 것 말고는
 * 빠져나올 길이 없었다.
 *
 * 누가 저장소를 손대지 않아도 그렇게 된다. 다음 판에서 고를 수 있는 값이 바뀌면
 * **옛 값을 들고 있던 사람만** 조용히 갇힌다. 오래 쓴 사람일수록.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');

/** 브라우저 저장소 흉내. `mode: 'throw'` 로 막힌 저장소도 흉내 낸다. */
function stubStorage(initial = {}, mode = 'ok') {
  const data = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem(k) {
      if (mode === 'throw') throw new Error('접근이 차단되었습니다');
      return data.has(k) ? data.get(k) : null;
    },
    setItem(k, v) {
      if (mode === 'throw') throw new Error('저장 공간이 없습니다');
      data.set(k, String(v));
    },
  };
  return data;
}

test.afterEach(() => { delete globalThis.localStorage; });

test('기억해 둔 값이 허용된 것이면 그대로 쓴다', () => {
  stubStorage({ 'k.mode': 'quadrant' });
  assert.equal(remembered('k.mode', ['list', 'quadrant']), 'quadrant');
});

test('아무것도 없으면 첫 번째가 기본값', () => {
  stubStorage({});
  assert.equal(remembered('k.mode', ['list', 'quadrant']), 'list');
});

test('허용되지 않는 값은 기본값으로 돌아간다', () => {
  stubStorage({ 'k.days': 'abc' });
  assert.equal(remembered('k.days', [14, 7, 30]), 14,
    '숫자가 아닌 값이 그대로 서버로 나가면 화면이 통째로 막힌다');
});

test('예전 판에서 쓰던 값이 남아 있어도 갇히지 않는다', () => {
  // 여기가 진짜 시나리오다 — 사용자는 아무것도 잘못하지 않았다.
  stubStorage({ 'k.mode': 'kanban' }); // 지금은 없어진 보기 방식
  assert.equal(remembered('k.mode', ['list', 'quadrant']), 'list');
});

test('숫자로 저장한 값은 숫자로 돌아온다', () => {
  stubStorage({ 'k.days': '30' });
  const got = remembered('k.days', [14, 7, 30, 90]);
  assert.equal(got, 30);
  assert.equal(typeof got, 'number', '문자열 "30" 이 그대로 나가면 비교와 계산이 어긋난다');
});

test('저장소를 못 쓰는 브라우저에서도 화면은 뜬다', () => {
  stubStorage({}, 'throw');
  assert.equal(remembered('k.mode', ['list', 'quadrant']), 'list');
  assert.doesNotThrow(() => remember('k.mode', 'quadrant'),
    '선택을 기억하지 못하는 것과 화면이 죽는 것은 전혀 다른 일이다');
});

test('저장소가 아예 없어도(노드 등) 터지지 않는다', () => {
  delete globalThis.localStorage;
  assert.equal(remembered('k.mode', ['list', 'quadrant']), 'list');
  assert.doesNotThrow(() => remember('k.mode', 'list'));
});

test('기억한 값을 다시 읽으면 그대로 나온다', () => {
  const data = stubStorage({});
  remember('k.days', 90);
  assert.equal(data.get('k.days'), '90');
  assert.equal(remembered('k.days', [14, 90]), 90);
});

/**
 * 화면이 저장소를 직접 만지지 않는지.
 *
 * 위 규칙은 `remembered()` 를 통과하는 값만 지킨다. 어느 화면이든 `localStorage` 를
 * 그냥 읽는 순간 그 화면만 다시 예전 상태로 돌아간다 — 그리고 그건 눈에 띄지 않는다.
 */
test('화면은 localStorage 를 직접 읽지 않는다', () => {
  const offenders = [];
  const dirs = ['web/views', 'web/lib'];
  for (const dir of dirs) {
    for (const f of fs.readdirSync(path.join(ROOT, dir)).filter((x) => x.endsWith('.js'))) {
      const rel = `${dir}/${f}`;
      if (rel === 'web/lib/store.js') continue; // 여기가 유일한 창구다
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      src.split('\n').forEach((line, i) => {
        if (/localStorage\.getItem/.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
  }
  assert.deepEqual(offenders, [], `\n  ${offenders.join('\n  ')}\n  remembered() 를 쓰세요.`);
});
