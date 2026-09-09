import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('time');
const time = await import('../server/lib/time.mjs');

test('업무일 경계는 설정한 시각을 기준으로 나뉜다', () => {
  time.setDayStartHour(4);
  // 새벽 2시는 아직 "전날"
  assert.equal(time.dayKey(at('2026-03-10', 2, 30)), '2026-03-09');
  // 오전 4시부터 새 하루
  assert.equal(time.dayKey(at('2026-03-10', 4, 0)), '2026-03-10');
  assert.equal(time.dayKey(at('2026-03-10', 23, 59)), '2026-03-10');
});

test('dayStartHour 0 이면 달력 날짜와 같다', () => {
  time.setDayStartHour(0);
  assert.equal(time.dayKey(at('2026-03-10', 2, 30)), '2026-03-10');
  time.setDayStartHour(4);
});

test('dayRange 는 시작 시각부터 다음 날 같은 시각까지', () => {
  time.setDayStartHour(4);
  const [start, end] = time.dayRange('2026-03-10');
  assert.equal(new Date(start).getHours(), 4);
  assert.equal(new Date(end).getHours(), 4, '서머타임이 있어도 경계 시각은 같아야 한다');
  assert.equal(new Date(end).getDate(), 11);
  // 서머타임이 없는 지역이라면 정확히 24시간이다.
  assert.ok(Math.abs(end - start - 86_400_000) <= 3_600_000);
});

test('연속한 업무일 구간은 빈틈도 겹침도 없다', () => {
  time.setDayStartHour(4);
  for (const key of ['2026-03-07', '2026-03-08', '2026-10-24', '2026-10-25', '2026-12-31']) {
    const [, end] = time.dayRange(key);
    const [nextStart] = time.dayRange(time.shiftDay(key, 1));
    assert.equal(end, nextStart, `${key} 의 끝은 다음 날의 시작과 같아야 한다`);
  }
});

test('shiftDay 는 월말과 연말을 넘어간다', () => {
  assert.equal(time.shiftDay('2026-03-01', -1), '2026-02-28');
  assert.equal(time.shiftDay('2026-12-31', 1), '2027-01-01');
  assert.equal(time.shiftDay('2028-02-28', 1), '2028-02-29'); // 윤년
});

test('lastDays 는 오래된 날부터 n개를 돌려준다', () => {
  const days = time.lastDays(3, '2026-03-10');
  assert.deepEqual(days, ['2026-03-08', '2026-03-09', '2026-03-10']);
});

test('weekOf 는 월요일부터 7일을 돌려준다', () => {
  const week = time.weekOf('2026-03-11'); // 수요일
  assert.equal(week.length, 7);
  assert.equal(week[0], '2026-03-09'); // 월요일
  assert.equal(week[6], '2026-03-15');
  const [start] = time.dayRange(week[0]);
  assert.equal(new Date(start).getDay(), 1);
});

test('humanDuration 은 단위를 적절히 접는다', () => {
  assert.equal(time.humanDuration(0), '0분');
  assert.equal(time.humanDuration(45), '45초');
  assert.equal(time.humanDuration(600), '10분');
  assert.equal(time.humanDuration(3600), '1시간');
  assert.equal(time.humanDuration(5400), '1시간 30분');
  assert.equal(time.humanDuration(-5), '0분');
});

test('시간 표기는 깨진 값을 0분으로 위장하지 않는다', async () => {
  // 예전에는 `sec || 0` 이라 NaN 이 조용히 '0분' 이 됐다. 그러면 계산이 깨진 자리가
  // **정상적인 0으로 보인다** — 사용자는 없는 사실을 믿게 되고, 문장만 보는 검사도 못 잡는다.
  // 실제로 이것 때문에 주간 문장의 오타(t.block_sec → t.blockSec)를 놓쳤다.
  const { dur } = await import('../web/lib/format.js');
  const { humanDuration } = time;

  for (const fn of [humanDuration, dur]) {
    // 없는 값은 예전처럼 0으로 본다 — 선택 항목에 흔하다.
    assert.equal(fn(null), '0분');
    assert.equal(fn(undefined), '0분');
    assert.equal(fn(0), '0분');

    // 깨진 값은 눈에 띄어야 한다.
    assert.equal(fn(NaN), '?분');
    assert.equal(fn('숫자아님'), '?분');
    assert.equal(fn(Infinity), '?분');

    // 평범한 값은 그대로.
    assert.equal(fn(45), '45초');
    assert.equal(fn(90), '2분');
    assert.equal(fn(5400), '1시간 30분');
  }

  // 클라이언트와 서버가 같은 규칙을 쓴다 — 화면과 내보낸 문서가 달라 보이면 안 된다.
  for (const v of [0, 45, 90, 3600, 5400, 7325, null, NaN]) {
    assert.equal(dur(v), humanDuration(v), `${v} 에서 화면과 서버 표기가 다릅니다`);
  }
});

/**
 * `dayKey()` 와 `dayRange()` 는 서로의 역이어야 한다.
 *
 * 예전 `dayKey()` 는 `ts - 시작시각*3600000` 을 빼서 날짜를 읽었다. 서머타임이 없는 곳에서는
 * 같은 결과지만, 있는 곳에서는 전환일에 어긋난다 — 미국 동부 기준 2026-03-08 04:30 이
 * `2026-03-07` 로 매겨졌는데 그 업무일의 범위는 03-07 04:00 ~ 03-08 04:00 이라 그 시각을
 * 담지 못했다. 기록은 남아 있는데 어느 날의 조회에도 걸리지 않는다 —
 * **한 해 두 번, 한 시간씩 조용히 사라지는** 종류의 고장이다.
 *
 * 아래 두 검사가 짝이다. 앞의 것은 지금 타임존에서 정의가 어긋나지 않았는지 보고,
 * 뒤의 것은 **서머타임이 있는 타임존을 실제로 띄워** 확인한다. 한국에서만 돌려서는
 * 이 결함을 절대 만날 수 없으므로, 뒤의 것이 없으면 검사가 있으나 마나다.
 */
test('매긴 업무일의 범위는 반드시 그 시각을 담는다', () => {
  const days = ['2026-03-07', '2026-03-08', '2026-03-09', '2026-10-31', '2026-11-01', '2026-11-02'];
  const hours = [0, 1, 2, 3, 4, 5, 6, 12, 22, 23];
  const problems = [];

  for (const startHour of [0, 2, 3, 4, 5, 6, 12, 23]) {
    time.setDayStartHour(startHour);
    for (const day of days) {
      for (const h of hours) {
        const ts = at(day, h, 30);
        const key = time.dayKey(ts);
        const [start, end] = time.dayRange(key);
        if (!(ts >= start && ts < end)) {
          problems.push(`시작 ${startHour}시 · ${day} ${h}:30 → ${key} (범위 밖)`);
        }
      }
    }
  }
  time.setDayStartHour(4);
  assert.deepEqual(problems.slice(0, 5), [], `${problems.length}개가 어긋납니다`);
});

test('날짜 이동은 왕복해도 제자리로 돌아온다', () => {
  time.setDayStartHour(4);
  for (const day of ['2026-01-01', '2026-02-28', '2026-03-08', '2026-10-31', '2026-11-01', '2026-12-31']) {
    for (const n of [1, 7, 30, 365]) {
      assert.equal(time.shiftDay(time.shiftDay(day, n), -n), day, `${day} ±${n}일`);
    }
  }
  // 달·해 경계도 달력대로 움직인다.
  assert.equal(time.shiftDay('2026-02-28', 1), '2026-03-01');
  assert.equal(time.shiftDay('2026-01-01', -1), '2025-12-31');
  assert.equal(time.shiftDay('2024-02-28', 1), '2024-02-29', '윤년');
});

/**
 * 서버와 화면의 시간 표기가 한 글자도 다르지 않아야 한다.
 *
 * 같은 규칙이 두 군데에 있다 — 서버의 `humanDuration()`(마크다운 리포트가 쓴다)과
 * 화면의 `dur()`. 어긋나면 같은 하루를 두고 리포트는 "2시간 15분", 화면은 "2시간 14분"
 * 이라고 말하게 된다. 둘 다 그럴듯해 보여서 어느 쪽이 틀렸는지 알 방법이 없다.
 *
 * "같은 규칙" 이라고 주석에 적어 두는 것으로는 지켜지지 않는다. 실제로 나란히 돌린다.
 */
test('시간·시각 표기가 서버와 화면에서 같다', async () => {
  const { dur, hhmm: clientHhmm } = await import('../web/lib/format.js');

  const values = [
    null, undefined, 0, 1, 30, 59, 60, 61, 89, 90, 119, 120, 3599, 3600, 3601,
    3660, 5400, 7199, 7200, 86_399, 86_400, 123_456, 0.4, 0.6, 59.5, -5,
    NaN, Infinity, -Infinity, '90', '3600',
  ];
  const diffs = [];
  for (const v of values) {
    const server = time.humanDuration(v);
    const client = dur(v);
    if (server !== client) diffs.push(`${JSON.stringify(v)}: 서버 "${server}" / 화면 "${client}"`);
  }
  assert.deepEqual(diffs, [], `시간 표기가 어긋납니다:\n  ${diffs.join('\n  ')}`);

  // 시각 표기도 마찬가지 — 리포트의 "14:30" 과 화면의 "14:30" 은 같아야 한다.
  const stamps = [
    at('2026-01-01', 0, 0), at('2026-01-01', 9, 5), at('2026-06-15', 14, 30),
    at('2026-12-31', 23, 59), Date.now(),
  ];
  const timeDiffs = stamps
    .filter((ts) => time.hhmm(ts) !== clientHhmm(ts))
    .map((ts) => `${ts}: 서버 "${time.hhmm(ts)}" / 화면 "${clientHhmm(ts)}"`);
  assert.deepEqual(timeDiffs, [], `시각 표기가 어긋납니다: ${timeDiffs.join(', ')}`);
});

/**
 * 업무일 계산이 **SQL 쪽에도** 하나 더 있다.
 *
 * 무결성 점검은 15만 행을 자바스크립트로 끌어올 수 없어 SQL 안에서 날짜를 다시 센다
 * (`backup.mjs` 의 `DAY_EXPR`). 이것이 `dayKey()` 와 어긋나면, 점검이 멀쩡한 행을
 * "날짜가 틀렸다" 고 잡고 → 고치기가 자바스크립트 값으로 바꾸고 → 다음 점검이 또 잡는다.
 * **아무리 눌러도 사라지지 않는 경고**가 되는데, 사용자는 왜인지 알 방법이 없다.
 *
 * 한 해 전체를 여러 경계 시각으로 훑어 두 계산이 한 글자도 다르지 않은지 본다.
 * (서머타임 지역 확인은 여기서 못 한다 — SQLite 의 'localtime' 은 운영체제 시간대를 쓰고
 *  TZ 환경변수로 바꿀 수 없다. 표현식 자체는 "로컬로 옮긴 뒤 빼는" 벽시계 방식이라
 *  `dayKey()` 와 정의가 같다.)
 */
test('SQL 안의 업무일 계산이 dayKey 와 같다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  // backup.mjs 가 쓰는 것과 같은 식. 여기에 복사해 두면 저쪽이 바뀌었을 때 이 검사가 못 잡는다.
  const src = await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../server/api/backup.mjs', import.meta.url), 'utf8',
  ));
  const m = /const DAY_EXPR = "([^"]+)"/.exec(src);
  assert.ok(m, 'backup.mjs 에서 DAY_EXPR 을 찾지 못했습니다 — 이름이 바뀌었다면 이 검사도 고쳐야 합니다');
  const expr = m[1].replace('started_at', '?');

  const stmt = db.prepare(`SELECT ${expr} AS k`);
  const problems = [];
  for (const startHour of [0, 3, 4, 5, 6, 12, 23]) {
    time.setDayStartHour(startHour);
    for (let day = 0; day < 365; day += 1) {
      for (const hour of [0, 1, 3, 4, 5, 12, 23]) {
        const ts = new Date(2026, 0, 1 + day, hour, 30, 0, 0).getTime();
        const js = time.dayKey(ts);
        const sql = stmt.get(ts, startHour).k;
        if (js !== sql) problems.push(`${startHour}시 기준 ${new Date(ts).toString().slice(0, 24)}: JS ${js} / SQL ${sql}`);
      }
    }
  }
  time.setDayStartHour(4);
  assert.deepEqual(problems.slice(0, 5), [], `${problems.length}개가 어긋납니다`);
});
