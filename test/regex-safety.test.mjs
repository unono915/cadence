import test from 'node:test';
import assert from 'node:assert/strict';
import { safeRegex } from '../server/lib/validate.mjs';

/**
 * 분류 규칙의 정규식은 사용자가 직접 쓴다. 잘못 붙여 넣은 하나가 서버 전체를
 * 멈춰 세울 수 있으므로(자바스크립트 정규식에는 시간 제한이 없다), 저장 전에 거른다.
 *
 * 여기서 확인하는 것은 두 가지다.
 *  - 터지는 패턴을 실제로 거절하는가
 *  - **평범한 패턴을 잘못 막지 않는가** — 이쪽이 더 중요하다. 안전 장치가 정상적인
 *    사용을 방해하면 사용자는 정규식 기능 자체를 쓰지 않게 된다.
 */

const EXPLOSIVE = [
  '(a+)+$',
  '([a-zA-Z]+)*$',
  '(a|a)*$',
  '(x+x+)+y',
  '(.*a){20}$',
  'a*a*a*a*b$',
  '^(([a-z])+.)+[A-Z]$',
];

const ORDINARY = [
  'github\\.com',
  '^(Slack|Discord)$',
  '.*\\.pdf$',
  '(회의|미팅)',
  'zoom|teams',
  '[0-9]{4}-[0-9]{2}',
  'localhost:\\d+',
  '^chrome$',
  'YouTube',
  '(?:docs|sheets)\\.google',
  '\\b(회의록|보고서)\\b',
  '\\.(js|mjs|ts)$',
  '^\\[.+\\]',
  '(https?://)?www\\.',
];

test('되짚기가 폭발하는 정규식은 거절한다', () => {
  for (const pattern of EXPLOSIVE) {
    assert.throws(
      () => safeRegex(pattern),
      (err) => err.status === 400,
      `${pattern} 이(가) 통과했습니다`,
    );
  }
});

test('평범한 정규식은 그대로 통과한다', () => {
  for (const pattern of ORDINARY) {
    assert.equal(safeRegex(pattern), pattern, `${pattern} 이(가) 막혔습니다`);
  }
});

test('검사 자체가 오래 걸리지 않는다', () => {
  // 검사가 곧 DoS 가 되면 안 된다 — 막으려던 것을 스스로 하는 셈이다.
  for (const pattern of [...EXPLOSIVE, ...ORDINARY]) {
    const t0 = performance.now();
    try { safeRegex(pattern); } catch { /* 거절도 정상 결과 */ }
    const spent = performance.now() - t0;
    assert.ok(spent < 1500, `${pattern} 검사에 ${spent.toFixed(0)}ms 가 걸렸습니다`);
  }
});

test('문법 오류와 길이 초과는 그대로 걸러진다', () => {
  assert.throws(() => safeRegex('(unclosed'), (err) => err.status === 400);
  assert.throws(() => safeRegex('a'.repeat(201)), (err) => err.status === 400);
});
