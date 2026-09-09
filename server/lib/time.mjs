/**
 * 시간 유틸. 저장은 전부 epoch ms(UTC)로 하고,
 * 하루 경계는 서버가 실행되는 로컬 타임존 기준으로 계산한다.
 * "업무 하루"는 자정이 아니라 설정된 시작 시각(기본 04:00)부터 24시간으로 본다 —
 * 새벽까지 이어지는 작업이 다음 날로 잘리지 않게 하기 위함.
 */

let dayStartHour = 4;

export function setDayStartHour(h) {
  dayStartHour = Math.max(0, Math.min(23, Number(h) || 0));
}

export function getDayStartHour() {
  return dayStartHour;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * epoch ms → 'YYYY-MM-DD' (업무일 기준)
 *
 * **벽시계 시각**으로 판단한다. 시작 시각보다 이르면 전날 몫이다.
 *
 * 예전에는 `ts - 시작시각*3600000` 을 빼서 날짜를 읽었다. 서머타임이 없는 곳에서는
 * 같은 결과지만, 있는 곳에서는 전환일에 `dayRange()` 와 어긋난다 — 실제로 미국 동부
 * 기준 2026-03-08 04:30 이 `2026-03-07` 로 매겨졌는데, 그 업무일의 범위는
 * 03-07 04:00 ~ 03-08 04:00 이라 그 시각을 담지 못한다. 기록은 남아 있는데 어느 날의
 * 조회에도 걸리지 않고, 한 해 두 번 한 시간씩 조용히 사라진다.
 *
 * `dayRange()` 도 벽시계로 만들므로, 이제 둘은 정확히 서로의 역이다.
 */
export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  if (d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 'YYYY-MM-DD' → 그 업무일의 [시작, 끝) epoch ms
 *
 * 끝은 "다음 날 같은 시각"으로 계산한다. 서머타임이 있는 지역에서는 하루가 23시간이나
 * 25시간일 수 있어서, 시작에 86,400,000 을 더하면 경계가 한 시간씩 어긋난다.
 */
export function dayRange(key) {
  const [y, m, d] = key.split('-').map(Number);
  const start = new Date(y, m - 1, d, dayStartHour, 0, 0, 0).getTime();
  const end = new Date(y, m - 1, d + 1, dayStartHour, 0, 0, 0).getTime();
  return [start, end];
}

/**
 * key 로부터 n일 이동한 날짜 키.
 *
 * 달력 날짜를 그대로 더한다. epoch ms 에 86,400,000 을 더하는 방식은 서머타임 전환일에
 * 한 시간이 모자라거나 남아 날짜가 밀리므로, 정오를 기준으로 잡아 그 여지를 없앤다.
 */
export function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(y, m - 1, d + n, 12, 0, 0, 0);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** 오늘을 포함해 과거 n일의 날짜 키 배열 (오래된 것부터) */
export function lastDays(n, from = dayKey()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(shiftDay(from, -i));
  return out;
}

/** 해당 업무일이 속한 주(월요일 시작)의 날짜 키 7개 */
export function weekOf(key = dayKey()) {
  const [start] = dayRange(key);
  const dow = (new Date(start).getDay() + 6) % 7; // 0 = 월
  const monday = shiftDay(key, -dow);
  return Array.from({ length: 7 }, (_, i) => shiftDay(monday, i));
}

/**
 * 초 → '2시간 15분' / '15분' / '45초'.
 * 마크다운 리포트가 한국어 업무 보고에 그대로 들어가므로 단위도 한국어로 쓴다.
 */
/** 초 → '2시간 15분'. 숫자가 아니면 '?분' — 깨진 계산이 정상적인 0으로 보이지 않도록. */
export function humanDuration(sec) {
  if (sec === null || sec === undefined) return '0분';
  const n = Number(sec);
  if (!Number.isFinite(n)) return '?분';
  const s = Math.max(0, Math.round(n));
  if (s === 0) return '0분';
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h}시간 ${rm}분` : `${h}시간`;
}

export function hhmm(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
