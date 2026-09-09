/** 표시용 포매터. 서버의 time.mjs 와 같은 규칙을 클라이언트에서도 쓴다. */

const pad = (n) => String(n).padStart(2, '0');

/**
 * 초 → '2시간 15분' / '15분' / '45초'
 *
 * 값이 숫자가 아니면 '?분' 을 낸다. 예전에는 `sec || 0` 이라 NaN 이 조용히 '0분' 이 됐는데,
 * 그러면 계산이 깨진 자리가 **정상적인 0으로 보인다** — 사용자는 없는 사실을 믿게 되고,
 * 검사도 문장만 봐서는 알아챌 수 없다. 없는 값(null/undefined)은 예전처럼 0으로 본다.
 */
export function dur(sec, { compact = false } = {}) {
  if (sec === null || sec === undefined) return '0분';
  const n = Number(sec);
  if (!Number.isFinite(n)) return '?분';
  const s = Math.max(0, Math.round(n));
  if (s === 0) return '0분';
  if (s < 60) return `${s}초`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}분`;
  const hours = Math.floor(m / 60);
  const rm = m % 60;
  if (compact) {
    const val = m / 60;
    return `${val >= 10 ? Math.round(val) : Number(val.toFixed(1))}시간`;
  }
  return rm ? `${hours}시간 ${rm}분` : `${hours}시간`;
}

/** 초 → 'HH:MM:SS' (타이머용) */
export function clock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${pad(m)}:${pad(r)}`;
}

export function hhmm(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function pct(part, whole) {
  if (!whole) return 0;
  const n = Math.round((part / whole) * 100);
  // 숫자가 아닌 값이 들어오면 화면에 'NaN%' 가 그대로 찍힌다. `dur()` 는 이미 '?분' 으로
  // 받아 내고 있는데 여기만 안 막혀 있어서, 같은 줄에 '?분 · NaN%' 가 나란히 나왔다.
  return Number.isFinite(n) ? n : 0;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD' → '9월 8일 (월)' */
export function dayLabel(key) {
  if (!key) return '';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${WEEKDAYS[date.getDay()]})`;
}

/**
 * 오늘의 업무일 키. **서버의 `time.mjs` 와 같은 규칙이어야 한다** —
 * 어긋나면 화면이 서버에 엉뚱한 날짜를 물어보고, 아무 오류 없이 다른 날을 보여 준다.
 *
 * 벽시계 시각으로 판단한다. 시각에서 몇 시간을 빼는 방식은 서머타임 전환일에
 * 업무일 경계와 어긋난다 (`test/dst.test.mjs` 가 두 구현이 같은지 지킨다).
 */
/**
 * epoch ms → `<input type="date">` 에 넣을 'YYYY-MM-DD'. **로컬 날짜**로 만든다.
 *
 * `toISOString()` 은 UTC 라서, UTC 보다 늦은 지역(로스앤젤레스 등)에서는 저녁 시각이
 * 다음 날로 넘어간다. 마감일을 9월 10일로 정해 두고 다시 열면 9월 11일이 떠 있고,
 * 그대로 저장하면 하루가 밀린다 — 마감일이 조용히 미뤄지는 종류의 고장이다.
 * 여기(한국)에서는 절대 재현되지 않아 눈으로 잡을 수 없다.
 */
export function isoDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function todayKey(dayStartHour = 4) {
  const d = new Date();
  if (d.getHours() < dayStartHour) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  // 정오를 기준으로 잡는다 — 자정이 존재하지 않는 서머타임 전환일에도 날짜가 밀리지 않도록.
  const date = new Date(y, m - 1, d + n, 12);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function relativeDay(key, today) {
  if (key === today) return '오늘';
  if (key === shiftDay(today, -1)) return '어제';
  if (key === shiftDay(today, 1)) return '내일';
  return dayLabel(key);
}

/**
 * 두 시각 사이의 **달력 날짜** 차이 (from 기준으로 to 가 며칠 뒤인가).
 *
 * 밀리초 차이를 86,400,000 으로 나누면 "몇 번의 24시간" 이 나온다 — 그건 며칠 뒤가 아니다.
 * 저녁 6시에 잡힌 내일 마감은 오늘 저녁 7시에 보면 23시간 뒤라 '0일' 이 되어 "오늘 마감"
 * 으로 보였다. 하필 남은 일을 훑어보는 시간대다.
 *
 * 서머타임이 있는 지역에서는 하루가 23시간이나 25시간일 수 있어 `Math.round` 로 묶는다.
 */
export function dayDiff(from, to) {
  const a = new Date(from);
  a.setHours(0, 0, 0, 0);
  const b = new Date(to);
  b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 86_400_000);
}

/**
 * 마감 표시 — 지났으면 빨간 문구를 붙일 수 있도록 상태도 함께 돌려준다.
 *
 * 남은 날수는 **달력 날짜**로 센다. 예전에는 밀리초 차이를 86,400,000 으로 나눴는데,
 * 그건 "지금부터 몇 번의 24시간" 이지 "며칠 뒤" 가 아니다. 마감이 보통 저녁 6시로
 * 잡히므로, **저녁이 되면 라벨이 하루씩 당겨졌다** — 내일 마감인 일이 "오늘 마감" 으로,
 * 3일 남은 일이 "2일 남음" 으로 보였다. 하필 남은 일을 훑어보는 시간대다.
 *
 * 서머타임이 있는 지역에서는 하루가 23시간이나 25시간일 수 있어 `Math.round` 로 묶는다.
 */
export function dueInfo(dueAt) {
  if (!dueAt) return null;
  const now = Date.now();
  if (dueAt < now) return { text: '기한 초과', overdue: true };

  const diffDays = dayDiff(now, dueAt);

  if (diffDays <= 0) return { text: '오늘 마감', soon: true };
  if (diffDays === 1) return { text: '내일 마감', soon: true };
  if (diffDays < 7) return { text: `${diffDays}일 남음` };
  const d = new Date(dueAt);
  return { text: `${d.getMonth() + 1}/${d.getDate()}` };
}

/**
 * 앞말의 받침에 따라 조사를 고른다.
 *
 * 시간 표기는 값에 따라 '30초' 도 되고 '3분' 도 된다. 문장을 '…{값}로' 처럼 고정해 두면
 * 절반은 '3분로' 같은 말이 된다 — 숫자가 바뀔 때마다 틀리는 자리라 눈에 잘 띄지도 않는다.
 *
 * @param {string} word 앞말
 * @param {string} pair '받침 있을 때/없을 때' 형식. 예: '으로/로', '은/는', '을/를'
 */
export function josa(word, pair) {
  const [withJong, withoutJong] = pair.split('/');
  const ch = String(word).trim().slice(-1);
  const code = ch.charCodeAt(0) || 0;

  let jong = -1; // 종성 인덱스. 0 이면 받침 없음.
  if (code >= 0xac00 && code <= 0xd7a3) {
    jong = (code - 0xac00) % 28;
  } else if (ch >= '0' && ch <= '9') {
    // 숫자는 읽는 소리를 따른다: 영·일·삼·육·칠·팔 에만 받침이 있다.
    jong = [21, 8, 0, 16, 0, 0, 1, 8, 8, 0][Number(ch)];
  } else {
    jong = 0; // 로마자·기호는 받침 없는 것으로 본다
  }

  // '으로/로' 만은 ㄹ 받침을 받침 없는 것처럼 다룬다 — '서울로', '1분으로'.
  if (jong === 8 && withJong.endsWith('로')) return withoutJong;
  return jong === 0 ? withoutJong : withJong;
}
