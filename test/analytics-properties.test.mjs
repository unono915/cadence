import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.mjs';

useTempData('props');
process.env.CADENCE_NO_TRACKER = '1';

/**
 * 몰입 블록은 이 도구의 대표 지표다. 정해 둔 몇 가지 상황으로만 확인하면
 * "그런 모양은 생각 못 했다" 는 구멍이 남는다.
 *
 * 그래서 무작위 하루를 수백 개 만들어, **어떤 입력에도 반드시 참이어야 하는 성질**을 건다.
 * 값이 얼마인지가 아니라 "말이 되는 값인지"를 보는 검사다.
 *
 * 무작위 검사는 실패할 때 원인을 알기 어려운 것이 약점이라, 실패하면 그 하루를
 * 그대로 되살릴 수 있는 씨앗을 함께 출력한다.
 */

const { deepBlocks } = await import('../server/api/analytics.mjs');

/** 재현 가능한 난수 (xorshift32). 실패한 씨앗을 그대로 다시 돌릴 수 있어야 한다. */
function rng(seed) {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

const KINDS = ['deep', 'deep', 'deep', 'shallow', 'comms', 'meeting', 'distraction', 'other'];

/** 겹치지 않고 이어지는 하루치 세그먼트. 실제 추적기가 만드는 모양과 같다. */
function makeDay(seed) {
  const rand = rng(seed);
  const segments = [];
  let cursor = Date.parse('2026-06-10T09:00:00');
  const count = 5 + Math.floor(rand() * 60);

  for (let i = 0; i < count; i++) {
    // 가끔 기록이 끊긴다(절전). 그 구간은 아예 비어 있다.
    if (rand() < 0.08) cursor += Math.floor(rand() * 3600_000);
    const seconds = 4 + Math.floor(rand() * 1800);
    const idle = rand() < 0.15;
    segments.push({
      app: `앱${Math.floor(rand() * 5)}`,
      started_at: cursor,
      ended_at: cursor + seconds * 1000,
      seconds,
      idle: idle ? 1 : 0,
      kind: idle ? 'other' : KINDS[Math.floor(rand() * KINDS.length)],
    });
    cursor += seconds * 1000;
  }
  return segments;
}

test('몰입 블록은 어떤 하루에도 말이 되는 값을 낸다', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const segments = makeDay(seed);
    const blocks = deepBlocks(segments, { minMin: 15, toleranceSec: 120, gapSec: 300 });
    const where = `씨앗 ${seed}`;

    const deepTotal = segments
      .filter((s) => !s.idle && s.kind === 'deep')
      .reduce((sum, s) => sum + s.seconds, 0);

    let prevEnd = -Infinity;
    for (const b of blocks) {
      assert.ok(b.end > b.start, `${where}: 블록의 끝이 시작보다 앞섭니다`);
      assert.ok(b.deep_sec > 0, `${where}: 몰입 시간이 0인 블록`);
      assert.ok(b.deep_sec <= b.span_sec + 1,
        `${where}: 몰입 시간(${b.deep_sec})이 블록 길이(${b.span_sec})보다 깁니다`);
      assert.ok(b.deep_sec >= 15 * 60, `${where}: 최소 길이에 못 미치는 블록이 나왔습니다`);
      assert.ok(b.breaks_sec >= 0, `${where}: 이탈 시간이 음수입니다`);
      assert.ok(b.start >= prevEnd, `${where}: 블록끼리 겹칩니다`);
      prevEnd = b.end;

      // 블록의 경계는 반드시 실제 몰입 세그먼트 위에 있다.
      assert.ok(segments.some((s) => !s.idle && s.kind === 'deep' && s.started_at === b.start),
        `${where}: 블록이 몰입 구간에서 시작하지 않습니다`);
      assert.ok(segments.some((s) => !s.idle && s.kind === 'deep' && s.ended_at === b.end),
        `${where}: 블록이 몰입 구간에서 끝나지 않습니다`);
    }

    const blockDeep = blocks.reduce((sum, b) => sum + b.deep_sec, 0);
    assert.ok(blockDeep <= deepTotal,
      `${where}: 블록 안 몰입(${blockDeep})이 하루 전체 몰입(${deepTotal})보다 많습니다`);
  }
});

test('기준을 느슨하게 하면 블록이 줄어들지 않는다', () => {
  // 허용 이탈을 늘리면 블록이 끊길 이유가 줄어든다. 그러니 블록 안의 몰입 시간 합계는
  // 절대 감소해서는 안 된다 — 이게 깨지면 판정 기준이 뒤엉킨 것이다.
  for (let seed = 1; seed <= 200; seed++) {
    const segments = makeDay(seed);
    const tight = deepBlocks(segments, { minMin: 15, toleranceSec: 30, gapSec: 300 });
    const loose = deepBlocks(segments, { minMin: 15, toleranceSec: 600, gapSec: 300 });
    const sum = (bs) => bs.reduce((s, b) => s + b.deep_sec, 0);
    assert.ok(sum(loose) >= sum(tight),
      `씨앗 ${seed}: 허용 이탈을 늘렸는데 몰입 시간이 줄었습니다 (${sum(tight)} → ${sum(loose)})`);
  }
});

test('최소 길이를 늘리면 블록 수가 늘어나지 않는다', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const segments = makeDay(seed);
    const short = deepBlocks(segments, { minMin: 5, toleranceSec: 120, gapSec: 300 });
    const long = deepBlocks(segments, { minMin: 60, toleranceSec: 120, gapSec: 300 });
    assert.ok(long.length <= short.length,
      `씨앗 ${seed}: 최소 길이를 늘렸는데 블록이 늘었습니다`);
  }
});

// --- Cadence 점수 ---

const { cadenceScore } = await import('../server/api/analytics.mjs');

/** 기본 하루. 필요한 값만 덮어쓴다. */
function scoreOf(overrides = {}) {
  const base = {
    kinds: { deep: 3 * 3600, distraction: 600 },
    blocks: [{ deep_sec: 2 * 3600 }],
    focus: { started: 4, completion_rate: 0.75 },
    switchesPerHour: 10,
    activeSec: 7 * 3600,
  };
  return cadenceScore({ ...base, ...overrides });
}

test('점수는 0에서 100 사이를 벗어나지 않는다', () => {
  const rand = rng(7);
  for (let i = 0; i < 500; i++) {
    const activeSec = Math.floor(rand() * 14 * 3600);
    const deep = Math.floor(rand() * activeSec);
    const s = cadenceScore({
      kinds: { deep, distraction: Math.floor(rand() * (activeSec - deep + 1)) },
      blocks: rand() < 0.3 ? [] : [{ deep_sec: Math.floor(deep * rand()) }],
      focus: { started: Math.floor(rand() * 12), completion_rate: rand() },
      switchesPerHour: rand() * 80,
      activeSec,
    });
    assert.ok(s.total >= 0 && s.total <= 100, `점수가 범위를 벗어났습니다: ${s.total}`);
    for (const [key, value] of Object.entries(s.parts)) {
      assert.ok(value === null || value >= 0, `${key} 항목이 음수입니다: ${value}`);
    }
  }
});

test('몰입 시간이 늘면 점수가 떨어지지 않는다', () => {
  // 이게 깨지면 점수가 "더 잘한 날을 더 낮게" 매기는 셈이라, 있는 편이 없느니만 못하다.
  let prev = -1;
  for (let hours = 0; hours <= 8; hours += 0.5) {
    const deep = Math.round(hours * 3600);
    const s = scoreOf({ kinds: { deep, distraction: 600 }, blocks: [{ deep_sec: deep }] });
    assert.ok(s.total >= prev, `몰입 ${hours}시간에서 점수가 떨어졌습니다 (${prev} → ${s.total})`);
    prev = s.total;
  }
});

test('앱 전환이 잦아질수록 점수가 오르지 않는다', () => {
  let prev = 101;
  for (let sw = 0; sw <= 40; sw += 2) {
    const s = scoreOf({ switchesPerHour: sw });
    assert.ok(s.total <= prev, `전환 ${sw}회/h 에서 점수가 올랐습니다 (${prev} → ${s.total})`);
    prev = s.total;
  }
});

test('방해 시간이 늘수록 점수가 오르지 않는다', () => {
  let prev = 101;
  for (let min = 0; min <= 180; min += 15) {
    const s = scoreOf({ kinds: { deep: 3 * 3600, distraction: min * 60 } });
    assert.ok(s.total <= prev, `방해 ${min}분에서 점수가 올랐습니다 (${prev} → ${s.total})`);
    prev = s.total;
  }
});

test('같은 몰입 시간이라면 블록으로 뭉친 쪽이 더 높다', () => {
  const deep = 4 * 3600;
  const scattered = scoreOf({ kinds: { deep, distraction: 600 }, blocks: [] });
  const half = scoreOf({ kinds: { deep, distraction: 600 }, blocks: [{ deep_sec: deep / 2 }] });
  const whole = scoreOf({ kinds: { deep, distraction: 600 }, blocks: [{ deep_sec: deep }] });
  assert.ok(scattered.total < half.total && half.total < whole.total,
    `연속성이 점수에 반영되지 않습니다: ${scattered.total} / ${half.total} / ${whole.total}`);
});

test('세션을 쓰지 않은 날이 그 이유만으로 낮아지지 않는다', () => {
  // 점수는 "일이 어떻게 흘렀는가"를 재는 것이지 "도구를 규칙대로 썼는가"를 재는 것이 아니다.
  const noSessions = scoreOf({ focus: { started: 0, completion_rate: 0 } });
  const perfect = scoreOf({ focus: { started: 6, completion_rate: 1 } });
  assert.equal(noSessions.session_scored, false);
  assert.equal(noSessions.parts.sessions, null);
  // 세션 항목을 뺀 나머지를 100점 만점으로 환산한다는 것은 "세션도 나머지만큼 했을 것"으로
  // 본다는 뜻이다. 그래서 완벽히 이행한 날보다 약간 낮고, 다 놓아 버린 날보다는 높다 —
  // 세션을 아예 안 쓴 것이 벌점이 되지도, 이득이 되지도 않는 자리다.
  assert.ok(noSessions.total < perfect.total,
    `세션을 완벽히 이행한 날(${perfect.total})이 안 쓴 날(${noSessions.total})보다 높아야 합니다`);
  assert.ok(perfect.total - noSessions.total <= 3,
    `세션을 안 쓴 것만으로 ${perfect.total - noSessions.total}점이나 벌어집니다`);

  // 다만 시작해 놓고 놓아 버린 날은 낮아진다 — 그 자체가 파편화의 신호이므로.
  const abandoned = scoreOf({ focus: { started: 6, completion_rate: 0 } });
  assert.ok(abandoned.total < noSessions.total,
    '세션을 시작해 놓고 모두 중단한 날이 더 높게 나옵니다');
});

test('기록이 거의 없는 날은 점수를 매기지 않는다', () => {
  const s = scoreOf({ activeSec: 120 });
  assert.equal(s.insufficient, true);
  assert.equal(s.total, 0);
});

// --- 업무 리듬 (시간대별 접기) ---

const { rhythm } = await import('../server/api/analytics.mjs');
const { run, get, all } = await import('../server/lib/db.mjs');
const { seedDefaults } = await import('../server/lib/categorize.mjs');
const { dayKey, shiftDay } = await import('../server/lib/time.mjs');

seedDefaults();

test('시간대별로 접어도 전체 시간이 새거나 불어나지 않는다', () => {
  // 시간 경계를 넘는 구간은 잘라서 각 시간대에 나눠 담는다. 이 계산이 어긋나면
  // 골든타임이 엉뚱한 시간대를 가리키는데, 화면만 봐서는 알 방법이 없다.
  const rand = rng(1234);
  run('DELETE FROM activity');

  const deepCat = get("SELECT id FROM categories WHERE kind = 'deep' LIMIT 1").id;
  const shallowCat = get("SELECT id FROM categories WHERE kind = 'shallow' LIMIT 1").id;

  const today = dayKey();
  let total = 0;
  let segments = 0;

  for (let d = 0; d < 10; d++) {
    const day = shiftDay(today, -d);
    const [y, m, dd] = day.split('-').map(Number);
    // 새벽 5시부터 밤까지, 시간 경계를 마구 넘나드는 구간들.
    let cursor = new Date(y, m - 1, dd, 5, 0, 0, 0).getTime();
    const end = new Date(y, m - 1, dd, 23, 0, 0, 0).getTime();
    while (cursor < end) {
      const seconds = 60 + Math.floor(rand() * 7200); // 1분~2시간
      const stop = Math.min(end, cursor + seconds * 1000);
      const secs = Math.round((stop - cursor) / 1000);
      const idle = rand() < 0.2;
      // 시간대마다 몰입 비율이 다르게 — 그래야 골든타임 판정이 실제로 검사된다.
      const hour = new Date(cursor).getHours();
      const deepChance = hour >= 9 && hour < 12 ? 0.85 : hour >= 14 && hour < 17 ? 0.5 : 0.15;
      const isDeep = !idle && rand() < deepChance;
      run(
        `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
         VALUES ('앱', '', '', ?, ?, ?, ?, ?, ?)`,
        cursor, stop, secs, idle ? 1 : 0, idle ? null : (isDeep ? deepCat : shallowCat), day,
      );
      if (!idle) { total += secs; segments++; }
      cursor = stop;
    }
  }

  const r = rhythm({ weeks: 4 });
  const byHour = r.hours.reduce((s, h) => s + h.active_sec, 0);
  const byWeekday = r.weekdays.reduce((s, w) => s + w.active_sec, 0);

  // 조각마다 최대 0.5초씩 어긋날 수 있다. 구간이 시간 경계를 넘으면 조각이 늘어난다.
  const slack = segments * 3;
  assert.ok(Math.abs(byHour - total) <= slack,
    `시간대 합계(${byHour})가 실제(${total})와 ${Math.abs(byHour - total)}초 차이납니다`);
  assert.ok(Math.abs(byWeekday - total) <= slack,
    `요일 합계(${byWeekday})가 실제(${total})와 어긋납니다`);

  for (const h of r.hours) {
    assert.ok(h.active_sec >= 0 && h.deep_sec >= 0, `${h.hour}시 값이 음수입니다`);
    assert.ok(h.deep_sec <= h.active_sec + 1, `${h.hour}시: 몰입이 활동보다 많습니다`);
    assert.ok(h.deep_ratio === null || (h.deep_ratio >= 0 && h.deep_ratio <= 1),
      `${h.hour}시: 비율이 0~1 밖입니다 (${h.deep_ratio})`);
  }

  // 골든타임은 실제로 후보 중 가장 높은 비율이어야 한다.
  if (r.best_window) {
    for (let hour = 0; hour < 23; hour++) {
      const a = r.hours[hour];
      const b = r.hours[hour + 1];
      if (a.days < 3 || b.days < 3) continue;
      const active = a.active_sec + b.active_sec;
      if (active < 1800) continue;
      const ratio = (a.deep_sec + b.deep_sec) / active;
      assert.ok(ratio <= r.best_window.deep_ratio + 0.001,
        `${hour}시 창(${ratio.toFixed(3)})이 골든타임(${r.best_window.deep_ratio})보다 높습니다`);
    }
    assert.ok(r.best_window.end_hour === r.best_window.start_hour + 2);
  }

  run('DELETE FROM activity');
});

test('시간 경계를 넘는 구간은 각 시간대에 정확히 나뉜다', () => {
  // 합계만 보면 경계 계산이 틀려도 알 수 없다 — 어느 쪽으로 잘못 나뉘든 총량은 같기 때문.
  // 그래서 답을 아는 구간 하나를 넣고 시간대별 값을 직접 확인한다.
  run('DELETE FROM activity');
  const deepCat = get("SELECT id FROM categories WHERE kind = 'deep' LIMIT 1").id;
  const today = dayKey();

  // 같은 모양을 사흘 넣는다 — 표본 3일 미만은 후보에서 빠지므로.
  for (let d = 0; d < 3; d++) {
    const day = shiftDay(today, -d);
    const [y, m, dd] = day.split('-').map(Number);
    const start = new Date(y, m - 1, dd, 10, 30, 0, 0).getTime();
    const stop = new Date(y, m - 1, dd, 13, 15, 0, 0).getTime(); // 10:30 → 13:15
    run(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES ('앱', '', '', ?, ?, ?, 0, ?, ?)`,
      start, stop, Math.round((stop - start) / 1000), deepCat, day,
    );
  }

  const r = rhythm({ weeks: 4 });
  const hour = (h) => r.hours[h].active_sec;
  assert.equal(hour(10), 3 * 30 * 60, '10시에는 30분씩만 들어가야 합니다');
  assert.equal(hour(11), 3 * 60 * 60, '11시는 한 시간이 통째로');
  assert.equal(hour(12), 3 * 60 * 60, '12시도 한 시간이 통째로');
  assert.equal(hour(13), 3 * 15 * 60, '13시에는 15분씩');
  assert.equal(hour(9), 0, '구간 밖 시간대는 0이어야 합니다');
  assert.equal(hour(14), 0);

  run('DELETE FROM activity');
});

test('기록이 없으면 리듬을 읽었다고 하지 않는다', () => {
  run('DELETE FROM activity');
  const r = rhythm({ weeks: 4 });
  assert.equal(r.enough, false);
  assert.equal(r.best_window, null);
  assert.equal(r.observed_days, 0);
  assert.equal(r.hours.length, 24);
  assert.ok(r.hours.every((h) => h.active_sec === 0 && h.deep_ratio === null));
});

// --- 기준선(평소) ---

const { baselineFor } = await import('../server/api/analytics.mjs');

/** 하루치 몰입 시간을 통째로 심는다. */
function seedDay(day, { deepMin = 0, shallowMin = 0 } = {}) {
  const [y, m, d] = day.split('-').map(Number);
  const deepCat = get("SELECT id FROM categories WHERE kind = 'deep' LIMIT 1").id;
  const shallowCat = get("SELECT id FROM categories WHERE kind = 'shallow' LIMIT 1").id;
  let cursor = new Date(y, m - 1, d, 9, 0, 0, 0).getTime();
  const put = (minutes, cat) => {
    if (minutes <= 0) return;
    const stop = cursor + minutes * 60_000;
    run(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES ('앱', '', '', ?, ?, ?, 0, ?, ?)`,
      cursor, stop, minutes * 60, cat, day,
    );
    cursor = stop;
  };
  put(deepMin, deepCat);
  put(shallowMin, shallowCat);
}

test('기준선은 중앙값이라 하루 몰아친 날에 흔들리지 않는다', () => {
  // 평균을 쓰면 하루 몰아친 날 하나가 "평소"를 통째로 끌어올린다.
  // 그러면 그 뒤로 며칠은 계속 "평소보다 못했다" 는 말을 듣게 된다.
  run('DELETE FROM activity');
  const today = dayKey();
  const days = [1, 2, 3, 4, 5].map((n) => shiftDay(today, -n));

  // 평범한 날 넷(각 2시간)과 몰아친 날 하나(10시간).
  for (const d of days.slice(0, 4)) seedDay(d, { deepMin: 120, shallowMin: 60 });
  seedDay(days[4], { deepMin: 600, shallowMin: 60 });

  const base = baselineFor(today);
  assert.equal(base.enough, true);
  assert.equal(base.days, 5);
  assert.equal(base.deep_sec, 120 * 60, `중앙값이어야 합니다 (평균이면 ${(120 * 4 + 600) / 5}분)`);

  run('DELETE FROM activity');
});

test('기록이 얕은 날은 기준선에서 뺀다', () => {
  // 30분도 안 앉아 있던 날(반차, 외근)이 "평소"에 섞이면 기준선이 바닥으로 내려간다.
  run('DELETE FROM activity');
  const today = dayKey();
  seedDay(shiftDay(today, -1), { deepMin: 180 });
  seedDay(shiftDay(today, -2), { deepMin: 180 });
  seedDay(shiftDay(today, -3), { deepMin: 5 });   // 5분 — 근무일이 아니다
  seedDay(shiftDay(today, -4), { deepMin: 180 });

  const base = baselineFor(today);
  assert.equal(base.days, 3, '얕은 날은 세지 않는다');
  assert.equal(base.deep_sec, 180 * 60);

  run('DELETE FROM activity');
});

test('표본이 세 날 미만이면 평소를 말하지 않는다', () => {
  run('DELETE FROM activity');
  const today = dayKey();
  seedDay(shiftDay(today, -1), { deepMin: 180 });
  seedDay(shiftDay(today, -2), { deepMin: 180 });

  const base = baselineFor(today);
  assert.equal(base.enough, false, '두 날로 "평소" 를 말하면 안 됩니다');
  assert.equal(base.deep_sec, undefined);

  run('DELETE FROM activity');
});

test('오늘은 자기 기준선에 들어가지 않는다', () => {
  // 오늘을 포함하면 "평소보다 많다/적다" 가 자기 자신과의 비교가 되어 무뎌진다.
  run('DELETE FROM activity');
  const today = dayKey();
  for (const n of [1, 2, 3]) seedDay(shiftDay(today, -n), { deepMin: 60 });
  seedDay(today, { deepMin: 600 });

  const base = baselineFor(today);
  assert.equal(base.days, 3);
  assert.equal(base.deep_sec, 60 * 60, '오늘의 10시간이 기준선에 섞였습니다');

  run('DELETE FROM activity');
});

// --- 주간 비교 (같은 일수끼리) ---

const { weekReport } = await import('../server/api/analytics.mjs');
const { weekOf } = await import('../server/lib/time.mjs');

test('주중에 열어도 지난주와 같은 일수끼리 견준다', () => {
  // 수요일에 주간 리뷰를 열면 이번 주는 3일뿐이다. 지난주 7일과 통째로 견주면
  // 언제나 "크게 줄었다" 로 나와서, 그 숫자를 보는 의미가 사라진다.
  run('DELETE FROM activity');
  const today = dayKey();
  const thisWeek = weekOf(today);
  const prevWeek = weekOf(shiftDay(thisWeek[0], -1));
  const elapsed = thisWeek.filter((d) => d <= today).length;

  // 이번 주 지나온 날마다 1시간씩.
  for (const d of thisWeek.slice(0, elapsed)) seedDay(d, { deepMin: 60 });
  // 지난주는 앞쪽 날마다 2시간, 뒤쪽 날마다 10시간.
  prevWeek.forEach((d, i) => seedDay(d, { deepMin: i < elapsed ? 120 : 600 }));

  const week = weekReport({ day: today });
  assert.equal(week.elapsed_days, elapsed);
  assert.equal(week.previous.compared_days, elapsed, '지난주도 같은 일수만 잘라야 합니다');
  assert.equal(week.totals.deep_sec, elapsed * 60 * 60);
  assert.equal(
    week.previous.deep_sec, elapsed * 120 * 60,
    '지난주 뒤쪽 날들이 비교에 섞였습니다 — 그러면 언제나 "크게 줄었다" 로 나옵니다',
  );

  run('DELETE FROM activity');
});

test('지난 주를 열면 온전한 7일끼리 견준다', () => {
  run('DELETE FROM activity');
  const today = dayKey();
  const lastWeek = weekOf(shiftDay(weekOf(today)[0], -1));
  const weekBefore = weekOf(shiftDay(lastWeek[0], -1));

  for (const d of lastWeek) seedDay(d, { deepMin: 60 });
  for (const d of weekBefore) seedDay(d, { deepMin: 30 });

  const week = weekReport({ day: lastWeek[3] });
  assert.equal(week.complete, true);
  assert.equal(week.elapsed_days, 7);
  assert.equal(week.previous.compared_days, 7);
  assert.equal(week.totals.deep_sec, 7 * 60 * 60);
  assert.equal(week.previous.deep_sec, 7 * 30 * 60);

  run('DELETE FROM activity');
});

// --- 시간대별 밀도 (오늘 화면의 히트맵) ---

const { hourlyDensity } = await import('../server/api/activity.mjs');

test('시간대별 밀도는 구간을 정확히 나누고 총량을 지킨다', () => {
  run('DELETE FROM activity');
  const today = dayKey();
  const [y, m, dd] = today.split('-').map(Number);
  const deepCat = get("SELECT id FROM categories WHERE kind = 'deep' LIMIT 1").id;

  const put = (fromH, fromM, toH, toM, idle = 0) => {
    const a = new Date(y, m - 1, dd, fromH, fromM).getTime();
    const b = new Date(y, m - 1, dd, toH, toM).getTime();
    run(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES ('앱', '', '', ?, ?, ?, ?, ?, ?)`,
      a, b, Math.round((b - a) / 1000), idle, idle ? null : deepCat, today,
    );
    return Math.round((b - a) / 1000);
  };

  let activeTotal = 0;
  let idleTotal = 0;
  activeTotal += put(9, 40, 12, 20);   // 세 시간대에 걸친다
  idleTotal += put(12, 20, 12, 50, 1); // 자리비움은 따로 센다
  activeTotal += put(14, 0, 14, 30);

  const buckets = hourlyDensity(today);
  assert.equal(buckets.length, 24);

  const at = (h) => buckets[h];
  assert.equal(at(9).active, 20 * 60, '9시에는 20분만');
  assert.equal(at(10).active, 3600, '10시는 통째로');
  assert.equal(at(11).active, 3600, '11시도 통째로');
  assert.equal(at(12).active, 20 * 60, '12시에는 20분');
  assert.equal(at(12).idle, 30 * 60, '자리비움은 따로 담긴다');
  assert.equal(at(13).active, 0, '기록 없는 시간대는 0');
  assert.equal(at(14).active, 30 * 60);

  const sumActive = buckets.reduce((s, b) => s + b.active, 0);
  const sumIdle = buckets.reduce((s, b) => s + b.idle, 0);
  assert.equal(sumActive, activeTotal, '활동 총량이 달라졌습니다');
  assert.equal(sumIdle, idleTotal, '자리비움 총량이 달라졌습니다');

  run('DELETE FROM activity');
});

test('시각이 망가진 기록이 와도 밀도 계산이 멈추지 않는다', () => {
  // 가져온 백업이나 손댄 데이터에는 말이 안 되는 시각이 들어올 수 있다.
  // 그때 무한 루프에 빠지면 화면이 통째로 멈춘다 — 되돌릴 방법도 없다.
  run('DELETE FROM activity');
  const today = dayKey();
  const [y, m, dd] = today.split('-').map(Number);
  const base = new Date(y, m - 1, dd, 10, 0).getTime();

  // 끝이 시작보다 이르고, 100년 뒤까지 뻗는 기록.
  run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('깨진', '', '', ?, ?, 60, 0, NULL, ?)`,
    base, base - 3600_000, today,
  );
  run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('아주긴', '', '', ?, ?, 60, 0, NULL, ?)`,
    base, base + 100 * 365 * 86_400_000, today,
  );

  const started = Date.now();
  const buckets = hourlyDensity(today);
  assert.ok(Date.now() - started < 2000, '계산이 멈추지 않고 끝나야 합니다');
  assert.equal(buckets.length, 24);
  // 업무일 범위 밖은 잘라 낸다 — 하루가 24시간을 넘을 수 없다.
  const total = buckets.reduce((s, b) => s + b.active + b.idle, 0);
  assert.ok(total <= 25 * 3600, `하루 총량이 ${Math.round(total / 3600)}시간입니다`);

  run('DELETE FROM activity');
});

test('미분류가 절반을 넘으면 점수를 믿지 말라고 표시한다', () => {
  // 미분류 시간은 몰입에도 방해에도 들어가지 않는다. 그래서 분류를 안 한 사람은
  // 무엇을 하든 낮은 점수를 받는다 — 그 숫자를 크게 띄우면 자기 하루가 나빴다고 읽는다.
  const clean = scoreOf({ kinds: { deep: 3 * 3600, other: 600 }, activeSec: 7 * 3600 });
  assert.equal(clean.unreliable, false);
  assert.ok(clean.unclassified_ratio < 0.1);

  const messy = scoreOf({ kinds: { deep: 1800, other: 6 * 3600 }, activeSec: 7 * 3600, blocks: [] });
  assert.equal(messy.unreliable, true, '미분류가 86% 인데 그대로 믿으라고 합니다');
  assert.equal(messy.unclassified_ratio, 0.857);
  // 값 자체는 그대로 둔다 — 지워 버리면 나아지는지 볼 수가 없다.
  assert.ok(messy.total >= 0 && messy.total <= 100);

  // 경계 근처
  assert.equal(scoreOf({ kinds: { deep: 3600, other: 3.4 * 3600 }, activeSec: 7 * 3600, blocks: [] }).unreliable, false);
  assert.equal(scoreOf({ kinds: { deep: 3600, other: 3.6 * 3600 }, activeSec: 7 * 3600, blocks: [] }).unreliable, true);

  // 기록이 얕은 날에는 이 이야기를 꺼내지 않는다 — 이미 '점수 없음' 이다.
  const tiny = scoreOf({ activeSec: 120 });
  assert.equal(tiny.insufficient, true);
  assert.equal(tiny.unreliable, false);
});

test('추세에도 신뢰할 수 없는 날인지 함께 실어 보낸다', async () => {
  // 하루 화면에서는 "이 점수는 아직 하루를 설명하지 못합니다" 라고 말해 놓고
  // 리포트의 평균 점수에는 조용히 섞어 버리면, 경고는 무의미해지고 평균만 이유 없이 낮아진다.
  const { trend } = await import('../server/api/analytics.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const cats = all('SELECT id, name, kind FROM categories');
  const other = cats.find((c) => c.kind === 'other');
  const deep = cats.find((c) => c.kind === 'deep');
  const today = dayKey();

  run('DELETE FROM activity');
  const t = Date.now() - 4 * 3600_000;
  const put = (offsetMin, minutes, categoryId) => run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('x', '', '', ?, ?, ?, 0, ?, ?)`,
    t + offsetMin * 60_000, t + (offsetMin + minutes) * 60_000, minutes * 60, categoryId, today,
  );
  put(0, 30, deep.id);
  put(30, 120, other.id); // 미분류가 80%

  const row = trend({ days: 2 }).find((d) => d.day === today);
  assert.equal(row.unreliable, true);
  assert.equal(row.unclassified_ratio, 0.8);

  // 정리하고 나면 표시가 사라진다 — 나아지는 것이 보여야 정리할 마음이 든다.
  run('UPDATE activity SET category_id = ? WHERE category_id = ?', deep.id, other.id);
  const fixed = trend({ days: 2 }).find((d) => d.day === today);
  assert.equal(fixed.unreliable, false);
  assert.equal(fixed.unclassified_ratio, 0);

  run('DELETE FROM activity');
});

test('블록이 하루 몰입보다 크게 들어와도 점수가 100을 넘지 않는다', () => {
  // 실제로는 같은 세그먼트에서 나오므로 있을 수 없는 값이지만, 어긋난 값이 들어오면
  // 점수가 120 같은 숫자가 되어 화면이 대놓고 틀려 보인다. 묶어 두는 편이 싸다.
  const s = scoreOf({
    kinds: { deep: 1800, distraction: 0 },
    blocks: [{ deep_sec: 10 * 3600 }],
    activeSec: 7 * 3600,
  });
  assert.ok(s.total <= 100, `점수가 ${s.total} 입니다`);
  assert.ok(s.parts.continuity <= 20, `연속성 항목이 ${s.parts.continuity} 입니다`);
});
