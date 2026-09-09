import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * 서머타임이 있는 타임존에서도 업무일 계산이 맞는지 본다.
 *
 * 이 도구를 만든 자리(한국)에는 서머타임이 없다. 그래서 `dayKey()` 가 시각에서 네 시간을
 * 빼는 방식으로 되어 있어도 아무 문제가 없었다 — 여기서는 결과가 같기 때문이다.
 * 서머타임이 있는 곳에서는 전환일에 `dayRange()` 와 어긋난다. 미국 동부 기준
 * 2026-03-08 04:30 이 `2026-03-07` 로 매겨졌는데, 그 업무일의 범위는
 * 03-07 04:00 ~ 03-08 04:00 이라 그 시각을 담지 못한다. 기록은 DB 에 남아 있는데
 * 어느 날의 조회에도 걸리지 않는다 — **한 해 두 번, 한 시간씩 조용히 사라진다.**
 *
 * 여기서만 돌려서는 절대 만날 수 없는 결함이므로, 타임존을 바꿔 **자식 프로세스를 실제로
 * 띄운다.** `TZ` 는 프로세스가 시작될 때 한 번 읽히므로 안에서 바꿔서는 소용이 없다.
 */

/**
 * 시각 훑기(`npm run test:clock`)는 검사를 하루 열세 번 돌린다. 그때마다 타임존을 바꾼
 * 자식 프로세스를 열넷씩 띄우면 훑기 한 번이 몇 분이 되는데, 얻는 것은 없다 —
 * 이 검사가 보는 것은 "지금 몇 시냐" 가 아니라 "어느 타임존이냐" 라서 결과가 늘 같다.
 * 그래서 훑기 중에는 건너뛴다. 건너뛴 사실은 검사 결과에 그대로 표시된다.
 */
const tzTest = process.env.CLOCK_SHIFT_H === undefined ? test : test.skip;

const here = path.dirname(fileURLToPath(import.meta.url));
// 윈도우 절대경로(C:\…)는 ESM 이 'c:' 스킴으로 읽어 버린다. file:// URL 로 넘긴다.
const TIME_MJS = pathToFileURL(path.resolve(here, '..', 'server', 'lib', 'time.mjs')).href;
const FORMAT_JS = pathToFileURL(path.resolve(here, '..', 'web', 'lib', 'format.js')).href;

/** 서머타임 전환이 있는 지역들 — 남반구(가을·봄이 반대)와 30분 단위 지역도 넣는다. */
const ZONES = [
  'America/New_York',
  'Europe/Berlin',
  'Europe/London',
  'Australia/Sydney',
  'America/Sao_Paulo',
  'Pacific/Chatham', // +12:45 / +13:45 — 45분 단위 오프셋
  'Asia/Seoul', // 서머타임 없음 — 대조군
];

/**
 * 자식 프로세스에서 돌릴 검사.
 *
 * 한 해 전체를 훑는다. 전환일이 언제인지 지역마다 다르므로 날짜를 골라 넣는 것보다
 * 365일을 다 보는 편이 확실하고, 그래도 한 지역에 1초가 안 걸린다.
 */
const PROBE = `
import { dayKey, dayRange, shiftDay, setDayStartHour } from '${TIME_MJS}';
const problems = [];
for (const startHour of [0, 3, 4, 5, 6]) {
  setDayStartHour(startHour);
  for (let day = 0; day < 365; day++) {
    for (const hour of [0, 1, 2, 3, 4, 5, 12, 23]) {
      const d = new Date(2026, 0, 1 + day, hour, 30, 0, 0);
      const ts = d.getTime();
      const key = dayKey(ts);
      const [start, end] = dayRange(key);
      if (!(ts >= start && ts < end)) {
        problems.push(startHour + '시 기준 ' + d.toString().slice(0, 24) + ' → ' + key);
      }
    }
    // 하루 앞뒤로 옮겼다 돌아오면 제자리여야 한다.
    const key = dayKey(new Date(2026, 0, 1 + day, 12).getTime());
    if (shiftDay(shiftDay(key, 1), -1) !== key) problems.push('왕복 어긋남 ' + key);
  }
}
console.log(JSON.stringify(problems.slice(0, 6)));
`;

tzTest('서머타임이 있는 타임존에서도 업무일이 어긋나지 않는다', () => {
  const failures = [];
  for (const tz of ZONES) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 60_000,
    });

    if (res.status !== 0) {
      failures.push(`${tz}: 프로브가 실패했습니다 — ${(res.stderr || '').trim().slice(0, 200)}`);
      continue;
    }
    // 타임존이 실제로 바뀌지 않았다면 이 검사는 아무것도 지키지 않는다.
    const applied = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(Intl.DateTimeFormat().resolvedOptions().timeZone)'],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' },
    ).stdout;
    assert.equal(applied, tz, `TZ 가 적용되지 않았습니다 (${applied}) — 이 검사는 헛돌고 있습니다`);

    const problems = JSON.parse(res.stdout.trim().split('\n').pop());
    if (problems.length) failures.push(`${tz}: ${problems.join(' | ')}`);
  }

  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
});

/**
 * 서버와 화면이 같은 날짜를 가리키는지.
 *
 * 업무일 계산이 두 군데에 있다 — 서버의 `time.mjs` 와 화면의 `format.js`.
 * 어긋나면 화면이 서버에 엉뚱한 날짜를 물어보고, **아무 오류 없이 다른 날을 보여 준다.**
 * 서머타임 전환일에는 그 한 시간 동안 화면이 어제를 오늘이라고 말하게 된다.
 *
 * 같은 규칙이라고 주석에 적어 두는 것으로는 지켜지지 않는다. 실제로 두 함수를 나란히
 * 돌려 본다 — 한 해 전체를, 서머타임이 있는 타임존에서.
 */
/**
 * 마감일이 하루 밀리지 않는지.
 *
 * `<input type="date">` 는 'YYYY-MM-DD' 만 받는다. 그 값을 `toISOString()` 으로 만들면
 * **UTC 날짜**가 되어, UTC 보다 늦은 지역(로스앤젤레스 등)에서는 저녁 시각이 다음 날로
 * 넘어간다. 마감일을 9월 10일로 정해 두고 다시 열면 9월 11일이 떠 있고, 그대로 저장하면
 * 하루가 밀린다 — 마감일이 조용히 미뤄지는 종류의 고장이다.
 *
 * 여기(한국, UTC+9)에서는 저녁 6시가 UTC 로도 같은 날이라 절대 재현되지 않는다.
 */
const DUE_PROBE = `
import { isoDay } from '${FORMAT_JS}';
const problems = [];
for (let day = 0; day < 365; day++) {
  const d = new Date(2026, 0, 1 + day);
  const key = d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
  // 화면이 저장하는 방식 그대로: 그날 로컬 18시.
  const saved = new Date(key + 'T18:00:00').getTime();
  const shown = isoDay(saved);
  if (shown !== key) problems.push(key + ' 로 정했는데 ' + shown + ' 로 보입니다');
}
console.log(JSON.stringify(problems.slice(0, 5)));
`;

tzTest('마감일이 타임존 때문에 하루 밀리지 않는다', () => {
  const failures = [];
  for (const tz of [...ZONES, 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Auckland']) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', DUE_PROBE], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (res.status !== 0) {
      failures.push(`${tz}: 프로브 실패 — ${(res.stderr || '').trim().slice(0, 200)}`);
      continue;
    }
    const problems = JSON.parse(res.stdout.trim().split('\n').pop());
    if (problems.length) failures.push(`${tz}: ${problems.join(' | ')}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
});

const AGREE_PROBE = `
import { dayKey, shiftDay as serverShift, setDayStartHour } from '${TIME_MJS}';
import { todayKey, shiftDay as clientShift } from '${FORMAT_JS}';

const RealDate = Date;
const problems = [];
for (const startHour of [0, 4, 6]) {
  setDayStartHour(startHour);
  for (let day = 0; day < 365; day++) {
    for (const hour of [0, 2, 3, 4, 5, 12, 23]) {
      const at = new RealDate(2026, 0, 1 + day, hour, 30, 0, 0).getTime();
      // todayKey() 는 '지금' 을 보므로, 지금을 그 시각으로 옮겨 놓고 부른다.
      globalThis.Date = new Proxy(RealDate, {
        construct(t, a) { return a.length ? new t(...a) : new t(at); },
        get(t, p) { return p === 'now' ? () => at : Reflect.get(t, p); },
      });
      const client = todayKey(startHour);
      globalThis.Date = RealDate;
      const server = dayKey(at);
      if (client !== server) {
        problems.push(startHour + '시 기준 ' + new RealDate(at).toString().slice(0, 24)
          + ' → 서버 ' + server + ' / 화면 ' + client);
      }
    }
    const key = dayKey(new RealDate(2026, 0, 1 + day, 12).getTime());
    for (const n of [1, -1, 7]) {
      if (serverShift(key, n) !== clientShift(key, n)) {
        problems.push('shiftDay 어긋남 ' + key + ' ' + n + '일: '
          + serverShift(key, n) + ' / ' + clientShift(key, n));
      }
    }
  }
}
console.log(JSON.stringify(problems.slice(0, 6)));
`;

tzTest('서버와 화면의 업무일 계산이 같은 날짜를 가리킨다', () => {
  const failures = [];
  for (const tz of ZONES) {
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', AGREE_PROBE], {
      env: { ...process.env, TZ: tz },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (res.status !== 0) {
      failures.push(`${tz}: 프로브 실패 — ${(res.stderr || '').trim().slice(0, 200)}`);
      continue;
    }
    const problems = JSON.parse(res.stdout.trim().split('\n').pop());
    if (problems.length) failures.push(`${tz}: ${problems.join(' | ')}`);
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
});
