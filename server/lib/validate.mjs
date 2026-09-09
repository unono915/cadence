import { badRequest } from './http.mjs';

export function str(value, field, { max = 500, min = 0, trim = true, allowEmpty = min === 0 } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return '';
    throw badRequest(`${field}: 값이 필요합니다`);
  }
  if (typeof value !== 'string') throw badRequest(`${field}: 문자열이어야 합니다`);
  const out = trim ? value.trim() : value;
  if (out.length < min) throw badRequest(`${field}: 최소 ${min}자 이상이어야 합니다`);
  if (out.length > max) throw badRequest(`${field}: 최대 ${max}자까지 가능합니다`);
  return out;
}

export function int(value, field, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return null;
    throw badRequest(`${field}: 값이 필요합니다`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw badRequest(`${field}: 숫자여야 합니다`);
  const i = Math.round(n);
  if (i < min || i > max) throw badRequest(`${field}: ${min}~${max} 범위여야 합니다`);
  return i;
}

/**
 * 시각(epoch ms) — 사람이 일하는 시간대 안에 있는지까지 본다.
 *
 * `int()` 만 쓰면 `1e15` 도, 음수도 그대로 들어온다. 실제로 태스크 기한에 그런 값을 넣으면
 * "33658년 9월 27일" 이 저장되고, 화면에는 "기한 초과 1,091만 일" 이라고 뜬다.
 * ±8.64e15 를 넘기면 `new Date()` 가 Invalid Date 가 되어 그 뒤 계산이 전부 NaN 이 된다 —
 * 어디서부터 잘못됐는지 알 수 없는 종류의 고장이다.
 *
 * 2000년부터 2100년까지로 묶는다. 활동 기록에도, 기한에도 넉넉한 범위다.
 */
const TS_MIN = Date.UTC(2000, 0, 1);
const TS_MAX = Date.UTC(2100, 0, 1);

export function ts(value, field, { optional = false } = {}) {
  const n = int(value, field, { optional });
  if (n === null) return null;
  if (n < TS_MIN || n > TS_MAX) {
    throw badRequest(`${field}: 2000년~2100년 사이의 시각이어야 합니다`);
  }
  return n;
}

export function oneOf(value, field, options, { optional = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (optional) return fallback;
    throw badRequest(`${field}: 값이 필요합니다`);
  }
  if (!options.includes(value)) {
    throw badRequest(`${field}: ${options.join(', ')} 중 하나여야 합니다`);
  }
  return value;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayString(value, field = 'day', fallback = null) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== null) return fallback;
    throw badRequest(`${field}: YYYY-MM-DD 형식이 필요합니다`);
  }
  if (typeof value !== 'string' || !DAY_RE.test(value)) {
    throw badRequest(`${field}: YYYY-MM-DD 형식이어야 합니다`);
  }
  return value;
}

export function color(value, field = 'color', fallback = '#6b7280') {
  if (!value) return fallback;
  if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
    throw badRequest(`${field}: #rrggbb 형식이어야 합니다`);
  }
  return value.toLowerCase();
}

/**
 * 분류 규칙에서 검사하는 문자열의 최대 길이.
 * 추적기가 창 제목을 400자로 자르므로 그보다 긴 입력은 들어오지 않는다.
 */
const MAX_HAYSTACK = 400;

const QUANTIFIER = /[*+]|\{\d+(,\d*)?\}/;

/**
 * 되짚기가 폭발하는 전형적인 모양: 수량자가 걸린 그룹에 다시 수량자가 붙은 것.
 *
 * 안쪽부터 그룹을 하나씩 자리표시자로 접어 가며 본다. 한 겹만 보면
 * `^(([a-z])+.)+[A-Z]$` 처럼 두 겹 안에 숨은 것을 놓친다.
 */
function hasNestedQuantifier(pattern) {
  let s = pattern.replace(/\\./g, 'x'); // 이스케이프된 글자는 그냥 글자로 본다
  for (let guard = 0; guard < 60; guard++) {
    const m = s.match(/\(([^()]*)\)([*+]|\{\d+(,\d*)?\})?/);
    if (!m) return false;
    const innerQuantified = QUANTIFIER.test(m[1]);
    if (m[2] && innerQuantified) return true;
    // 접고 나서도 "이 자리는 반복된다"는 사실은 남겨 둔다 — 바깥 겹에서 다시 걸리도록.
    const placeholder = innerQuantified || m[2] ? 'x*' : 'x';
    s = s.slice(0, m.index) + placeholder + s.slice(m.index + m[0].length);
  }
  return false;
}

/** 패턴에 실제로 등장하는 글자로 미끼 문자열을 만든다 — 'a' 만 써서는 (x+)+ 를 못 건드린다. */
function baitAlphabet(pattern) {
  const letters = pattern.replace(/\\./g, '').match(/[A-Za-z0-9가-힣]/g);
  if (!letters?.length) return 'a';
  return [...new Set(letters)].slice(0, 4).join('');
}

/**
 * 길이 n 의 미끼 문자열들.
 *
 * 섞인 쪽은 `(x+)+` 처럼 여러 글자가 얽힌 패턴을, 한 글자만 반복한 쪽은 `a*a*b` 처럼
 * 끝까지 훑어야 드러나는 패턴을 건드린다. 그리고 둘 다 **매치에 실패하도록** 패턴에
 * 없는 글자를 끝에 붙인다 — 되짚기 폭발은 "실패할 때" 일어나므로, 그냥 매치되는
 * 문자열로는 `(a|a)*$` 같은 것이 순식간에 통과해 버린다.
 */
function baits(pattern, alphabet, n) {
  const sentinel = [...'!@#~zqx'].find((c) => !pattern.includes(c)) || '!';
  const mixed = alphabet.repeat(Math.ceil(n / alphabet.length)).slice(0, n - 1) + sentinel;
  const flat = alphabet[0].repeat(n - 1) + sentinel;
  return mixed === flat ? [mixed] : [mixed, flat];
}

/**
 * 정규식 패턴이 안전하게 컴파일되고, 되짚기가 폭발하지 않는지 확인 (사용자 입력 규칙용).
 *
 * 규칙은 사용자가 직접 쓴다. `(a+)+$` 같은 패턴을 어디선가 복사해 붙이면 그 뒤로
 * 모든 활동 기록이 이 정규식을 거치는데, 자바스크립트 정규식에는 시간 제한이 없다.
 * 서버는 단일 스레드라 한 번 물리면 추적도 화면도 통째로 멈춘다 — 프로세스를 죽이는 것
 * 말고는 빠져나올 방법이 없고, 사용자는 "그냥 멈췄다" 이상을 알 수 없다.
 *
 * 그래서 저장하기 전에 실제로 돌려 본다. 짧은 문자열부터 조금씩 늘려 가며 시간을 재고,
 * 예산을 넘기면 거절한다. 지수적으로 터지는 패턴은 길이를 조금만 늘려도 티가 나므로
 * 짧은 쪽에서 잡히고, 검사 자체가 오래 걸리는 일은 없다.
 * 사다리를 통과한 뒤에는 실제 최대 길이(창 제목 400자)로 한 번 더 확인한다 —
 * 다항식으로 느려지는 패턴은 짧은 입력에서는 드러나지 않기 때문.
 */
export function safeRegex(pattern, field = 'pattern') {
  if (pattern.length > 200) throw badRequest(`${field}: 정규식이 너무 깁니다`);
  let re;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    throw badRequest(`${field}: 올바른 정규식이 아닙니다`, err.message);
  }

  if (hasNestedQuantifier(pattern)) {
    throw badRequest(
      `${field}: 되짚기가 폭발할 수 있는 정규식입니다`,
      '수량자가 붙은 그룹에 수량자가 또 붙어 있습니다 (예: (a+)+). 그룹 안쪽이나 바깥쪽 중 하나만 남겨 주세요.',
    );
  }

  const alphabet = baitAlphabet(pattern);
  const reject = () => {
    throw badRequest(
      `${field}: 너무 느린 정규식입니다`,
      '이 패턴은 입력이 조금만 길어져도 검사 시간이 급격히 늘어납니다. 더 단순한 패턴을 써 주세요.',
    );
  };

  // 길이를 촘촘히 늘려 간다. 한 번의 test() 는 중간에 멈출 수 없으므로,
  // 다음 단계가 감당 못할 만큼 비싸지기 전에 알아채야 한다.
  let spent = 0;
  for (const n of [8, 12, 16, 20, 24, 32, 48, 72, 110, 170, 260, MAX_HAYSTACK]) {
    for (const s of baits(pattern, alphabet, n)) {
      const t0 = performance.now();
      try { re.test(s); } catch { /* 실행 중 오류는 결과에 영향이 없다 */ }
      spent += performance.now() - t0;
      if (spent > 40) reject();
    }
  }

  return pattern;
}
