import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * 명령 팔레트의 초성 검색.
 *
 * 한글은 한 글자를 치려면 자모를 두세 번 눌러야 한다. 그래서 팔레트에서 태스크를 찾을 때
 * 제목을 다 치게 하면 마우스로 목록을 뒤지는 편이 빠르다 — 팔레트가 있으나 마나 해진다.
 * `ㅅㄴㅍ` 로 "성능 프로파일링" 이 나오는 것이 이 기능의 전부이자 핵심이다.
 */
const { initials } = await import('../web/views/palette.js');

test('한글을 초성으로 접는다', () => {
  assert.equal(initials('성능 프로파일링'), 'ㅅㄴ ㅍㄹㅍㅇㄹ');
  assert.equal(initials('설계 문서'), 'ㅅㄱ ㅁㅅ');
  assert.equal(initials('월간 회고 준비'), 'ㅇㄱ ㅎㄱ ㅈㅂ');

  // 한글이 아닌 글자는 그대로 두고 소문자로 맞춘다.
  assert.equal(initials('API 응답 스키마'), 'api ㅇㄷ ㅅㅋㅁ');
  assert.equal(initials('DB 마이그레이션'), 'db ㅁㅇㄱㄹㅇㅅ');
  assert.equal(initials('v2.1 릴리스'), 'v2.1 ㄹㄹㅅ');
  assert.equal(initials(''), '');
});

test('README 가 약속한 대로 ㅅㄴㅍ 로 성능 프로파일링을 찾는다', () => {
  // 공백을 무시해야 'ㅅㄴㅍ' 가 'ㅅㄴ ㅍㄹ…' 에 걸린다.
  const squash = (s) => initials(s).replace(/\s+/g, '');
  assert.ok(squash('성능 프로파일링').startsWith(squash('ㅅㄴㅍ')));
  assert.ok(squash('월간 회고 준비').startsWith(squash('ㅇㄱㅎ')));

  // 엉뚱한 초성에는 걸리지 않는다.
  assert.ok(!squash('성능 프로파일링').includes(squash('ㅁㅅㄱ')));
});

test('받침이 있는 글자도 첫 자음으로 접는다', () => {
  // 'ㄲ' 같은 쌍자음도 초성 표에 있어야 한다 — 없으면 검색에서 통째로 빠진다.
  assert.equal(initials('깔끔하게'), 'ㄲㄲㅎㄱ');
  assert.equal(initials('띄어쓰기'), 'ㄸㅇㅆㄱ');
  assert.equal(initials('빨리'), 'ㅃㄹ');
  assert.equal(initials('짧게'), 'ㅉㄱ');
});
