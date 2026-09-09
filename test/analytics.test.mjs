import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('analytics');
const { run, get } = await import('../server/lib/db.mjs');
const { seedDefaults } = await import('../server/lib/categorize.mjs');
const { setDayStartHour } = await import('../server/lib/time.mjs');
const { deepBlocks, cadenceScore, dayReport } = await import('../server/api/analytics.mjs');

seedDefaults();
setDayStartHour(4);

const DAY = '2026-06-01';
const catId = (name) => get('SELECT id FROM categories WHERE name = ?', name).id;

/** 초 단위 길이로 세그먼트를 만든다. kind 는 카테고리에서 유도된다. */
function seg(startMin, lenMin, kind, app = 'App') {
  const start = at(DAY, 9, 0) + startMin * 60_000;
  return {
    started_at: start,
    ended_at: start + lenMin * 60_000,
    seconds: lenMin * 60,
    idle: kind === 'idle' ? 1 : 0,
    kind: kind === 'idle' ? 'other' : kind,
    app,
  };
}

test('연속된 몰입 구간은 하나의 블록으로 묶인다', () => {
  const blocks = deepBlocks([
    seg(0, 20, 'deep'),
    seg(20, 25, 'deep'),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].deep_sec, 45 * 60);
});

test('짧은 이탈은 블록을 깨지 않지만 몰입 시간으로 세지도 않는다', () => {
  const blocks = deepBlocks([
    seg(0, 20, 'deep'),
    seg(20, 1, 'comms'),      // 60초 — 허용치(120초) 이내
    seg(21, 20, 'deep'),
  ]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].deep_sec, 40 * 60, '이탈 시간은 몰입에 포함되지 않는다');
  assert.equal(blocks[0].breaks_sec, 60);
});

test('허용치를 넘는 이탈은 블록을 끊는다', () => {
  const blocks = deepBlocks([
    seg(0, 20, 'deep'),
    seg(20, 10, 'comms'),     // 10분 — 허용치 초과
    seg(30, 20, 'deep'),
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].deep_sec, 20 * 60);
  assert.equal(blocks[1].deep_sec, 20 * 60);
});

test('최소 길이에 못 미치는 구간은 블록으로 세지 않는다', () => {
  const blocks = deepBlocks([
    seg(0, 8, 'deep'),
    seg(8, 20, 'comms'),
    seg(28, 9, 'deep'),
  ]);
  assert.equal(blocks.length, 0);
});

test('긴 기록 공백은 블록을 끊는다', () => {
  const blocks = deepBlocks([
    seg(0, 20, 'deep'),
    seg(120, 20, 'deep'),   // 100분 공백
  ]);
  assert.equal(blocks.length, 2);
});

test('기록이 거의 없는 날은 점수를 매기지 않는다', () => {
  const score = cadenceScore({
    kinds: { deep: 120 }, blocks: [], focus: { started: 0, completion_rate: null }, switchesPerHour: 0, activeSec: 120,
  });
  assert.equal(score.total, 0);
  assert.equal(score.insufficient, true);
});

test('같은 몰입 시간이라도 블록으로 뭉쳐 있으면 점수가 높다', () => {
  const common = { focus: { started: 4, completion_rate: 1 }, switchesPerHour: 6, activeSec: 6 * 3600 };
  const kinds = { deep: 3 * 3600 };

  const fragmented = cadenceScore({ ...common, kinds, blocks: [] });
  const consolidated = cadenceScore({
    ...common, kinds,
    blocks: [{ deep_sec: 3 * 3600 }],
  });

  assert.ok(consolidated.total > fragmented.total,
    `뭉친 쪽(${consolidated.total})이 흩어진 쪽(${fragmented.total})보다 높아야 한다`);
  assert.equal(consolidated.parts.continuity, 20);
  assert.equal(fragmented.parts.continuity, 0);
});

test('전환이 잦을수록 파편화 점수가 낮아진다', () => {
  const base = { kinds: { deep: 3600 }, blocks: [], focus: { started: 0, completion_rate: null }, activeSec: 4 * 3600 };
  const calm = cadenceScore({ ...base, switchesPerHour: 3 });
  const busy = cadenceScore({ ...base, switchesPerHour: 28 });
  assert.ok(calm.parts.fragmentation > busy.parts.fragmentation);
});

test('dayReport 는 DB 기록으로부터 일관된 합계를 만든다', () => {
  const base = at(DAY, 9, 0);
  const insert = (offsetMin, lenMin, cat, app) => run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, '', '', ?, ?, ?, 0, ?, ?)`,
    app, base + offsetMin * 60_000, base + (offsetMin + lenMin) * 60_000, lenMin * 60, catId(cat), DAY,
  );
  insert(0, 40, '개발', 'Code');
  insert(40, 20, '개발', 'Code');
  insert(60, 15, '커뮤니케이션', 'Slack');
  insert(75, 30, '방해요소', 'Chrome');

  const r = dayReport({ day: DAY });
  assert.equal(r.active_sec, 105 * 60);
  assert.equal(r.kinds.deep, 60 * 60);
  assert.equal(r.kinds.distraction, 30 * 60);
  assert.equal(r.deep_blocks.length, 1);
  assert.equal(r.deep_block_sec, 60 * 60);
  assert.equal(r.switches, 2, '같은 앱 연속 전환은 세지 않는다');
  assert.equal(
    r.by_category.reduce((s, c) => s + c.seconds, 0),
    r.active_sec,
    '카테고리 합계는 활동 시간과 같아야 한다',
  );
});

test('기준선은 기록된 날들의 중앙값이고, 표본이 적으면 매기지 않는다', async () => {
  const { baselineFor } = await import('../server/api/analytics.mjs');
  const { shiftDay } = await import('../server/lib/time.mjs');

  const target = '2026-07-20';
  const deepCat = catId('개발');

  const seed = (day, deepMin) => {
    const start = at(day, 9, 0);
    run(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES ('Code', '', '', ?, ?, ?, 0, ?, ?)`,
      start, start + deepMin * 60_000, deepMin * 60, deepCat, day,
    );
  };

  // 표본 2일 — 아직 기준선을 세우지 않는다.
  seed(shiftDay(target, -1), 120);
  seed(shiftDay(target, -2), 60);
  assert.equal(baselineFor(target).enough, false);

  // 3일째부터 중앙값을 낸다. 60 / 120 / 240 → 중앙값 120분
  seed(shiftDay(target, -3), 240);
  const base = baselineFor(target);
  assert.equal(base.enough, true);
  assert.equal(base.days, 3);
  assert.equal(base.deep_sec, 120 * 60);

  // 하루 몰아친 날이 있어도 중앙값은 크게 흔들리지 않는다.
  seed(shiftDay(target, -4), 900);
  assert.ok(baselineFor(target).deep_sec <= 240 * 60, '중앙값은 극단값에 끌려가지 않는다');

  // 기준일 자신은 기준선에 들어가지 않는다.
  seed(target, 600);
  assert.equal(baselineFor(target).days, 4);

  // 활동이 30분 미만인 날은 근무일로 보지 않는다.
  seed(shiftDay(target, -5), 10);
  assert.equal(baselineFor(target).days, 4);
});

test('업무 리듬은 시간대별 몰입 "비율"을 보고, 표본이 얇은 시간은 골든타임 후보에서 뺀다', async () => {
  const { rhythm } = await import('../server/api/analytics.mjs');
  const { shiftDay } = await import('../server/lib/time.mjs');

  run('DELETE FROM activity');

  const anchor = '2026-08-20';
  const deep = catId('개발');
  const comms = catId('커뮤니케이션');

  const put = (day, hour, minutes, category) => {
    const start = at(day, hour, 0);
    run(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES ('App', '', '', ?, ?, ?, 0, ?, ?)`,
      start, start + minutes * 60_000, minutes * 60, category, day,
    );
  };

  // 다섯 날: 10시에는 대부분 몰입, 14시에는 대부분 소통.
  for (let i = 1; i <= 5; i++) {
    const day = shiftDay(anchor, -i);
    put(day, 10, 50, deep);
    put(day, 11, 50, deep);
    put(day, 14, 50, comms);
    put(day, 15, 40, comms);
    put(day, 15, 10, deep);
  }
  // 하루만 있는 새벽 몰입 — 표본이 얇으므로 골든타임이 되면 안 된다.
  put(shiftDay(anchor, -1), 5, 55, deep);
  put(shiftDay(anchor, -1), 6, 55, deep);

  const r = rhythm({ day: anchor, weeks: 4 });
  assert.equal(r.enough, true);

  const ten = r.hours[10];
  assert.equal(ten.days, 5);
  assert.equal(ten.deep_ratio, 1);

  const fourteen = r.hours[14];
  assert.equal(fourteen.deep_ratio, 0, '소통만 한 시간대는 몰입 비율 0');

  assert.equal(r.best_window.start_hour, 10, `골든타임은 10시여야 한다 (실제 ${r.best_window.start_hour})`);
  assert.ok(r.best_window.deep_ratio > (r.worst_window?.deep_ratio ?? 1));

  // 새벽 구간은 관측일이 1일뿐이라 후보에서 빠진다.
  assert.equal(r.hours[5].days, 1);
  assert.ok(r.best_window.start_hour !== 5);

  // 하루 평균은 관측일로 나눈다 — 총합이 아니다.
  assert.equal(ten.deep_per_day, 50 * 60);
});

test('시각이 망가진 기록이 있어도 리듬·밀도 계산이 멈추지 않는다', async () => {
  const { rhythm } = await import('../server/api/analytics.mjs');
  const { hourlyDensity } = await import('../server/api/activity.mjs');

  run('DELETE FROM activity');
  const day = '2026-09-02';
  const base = at(day, 10, 0);
  const deep = catId('개발');

  // 정상 기록 하나
  run(`INSERT INTO activity(app,title,exe,started_at,ended_at,seconds,idle,category_id,day)
       VALUES ('App','','',?,?,?,0,?,?)`, base, base + 30 * 60_000, 1800, deep, day);
  // 끝이 100년 뒤인 손상 기록 (백업 가져오기로 들어올 수 있는 형태)
  run(`INSERT INTO activity(app,title,exe,started_at,ended_at,seconds,idle,category_id,day)
       VALUES ('Broken','','',?,?,?,0,?,?)`,
    base, base + 100 * 365 * 86_400_000, 3_153_600_000, deep, day);
  // 끝이 시작보다 이른 기록
  run(`INSERT INTO activity(app,title,exe,started_at,ended_at,seconds,idle,category_id,day)
       VALUES ('Reversed','','',?,?,?,0,?,?)`, base, base - 60_000, 60, deep, day);

  const started = Date.now();
  const r = rhythm({ day: '2026-09-05', weeks: 2 });
  const density = hourlyDensity(day);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 3000, `계산이 3초 안에 끝나야 한다 (실제 ${elapsed}ms)`);
  assert.equal(r.hours.length, 24);
  assert.equal(density.length, 24);
  assert.ok(density.every((b) => Number.isFinite(b.active) && b.active >= 0));
});

test('태스크 시간 집계는 인덱스를 타야 한다', async () => {
  const { db } = await import('../server/lib/db.mjs');

  // 태스크 목록은 모든 화면에서 불린다. 인덱스가 빠지면 기록이 쌓일수록
  // 태스크마다 활동 전체를 훑게 되어 조용히 느려진다 — 계획을 고정해 둔다.
  const sql = `
    SELECT t.id,
      (SELECT COALESCE(SUM(a.seconds), 0) FROM activity a
       WHERE a.task_id = t.id AND a.idle = 0
         AND NOT EXISTS (
           SELECT 1 FROM focus_sessions s2
           WHERE s2.task_id = a.task_id
             AND a.started_at < COALESCE(s2.ended_at, 9007199254740991)
             AND a.ended_at > s2.started_at)) AS tracked_sec
    FROM tasks t`;

  const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(' | ');
  assert.match(plan, /SEARCH a USING INDEX idx_activity_task_started/, `활동 조회가 인덱스를 못 탄다: ${plan}`);
  assert.match(plan, /SEARCH s2 USING INDEX idx_sessions_task/, `세션 겹침 확인이 인덱스를 못 탄다: ${plan}`);
  assert.ok(!/SCAN a\b/.test(plan), `활동 테이블 전체 스캔이 남아 있다: ${plan}`);
});

test('마이그레이션은 순서대로 적용되고 user_version 이 따라간다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  assert.ok(version >= 5, `user_version 이 ${version} 입니다 — 마이그레이션이 덜 적용되었습니다`);

  // 나중에 추가된 열들이 실제로 존재하는지 (마이그레이션이 조용히 건너뛰지 않았는지)
  const cols = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(cols('tasks').includes('planned_for'));
  assert.ok(cols('activity').includes('reviewed'));
  assert.ok(cols('projects').includes('weekly_target_min'));
});

test('세션을 쓰지 않은 날은 그 항목을 빼고 100점으로 환산한다', () => {
  const base = {
    kinds: { deep: 3 * 3600 },
    blocks: [{ deep_sec: 3 * 3600 }],
    switchesPerHour: 6,
    activeSec: 6 * 3600,
  };

  const noSessions = cadenceScore({ ...base, focus: { started: 0, completion_rate: null } });
  assert.equal(noSessions.session_scored, false);
  assert.equal(noSessions.parts.sessions, null, '항목 자체를 비운다');

  // 세션을 뺀 90점 만점을 100점으로 환산한 값이어야 한다.
  const observed = noSessions.parts.deep + noSessions.parts.continuity
    + noSessions.parts.fragmentation + noSessions.parts.distraction;
  assert.ok(Math.abs(noSessions.total - (observed / 90) * 100) <= 2,
    `환산이 어긋난다: ${noSessions.total} vs ${(observed / 90) * 100}`);

  // 도구를 안 썼다는 이유만으로 점수가 깎이면 안 된다.
  const withSessions = cadenceScore({ ...base, focus: { started: 6, completion_rate: 1 } });
  assert.ok(noSessions.total >= withSessions.total - 2,
    `세션을 안 쓴 날(${noSessions.total})이 다 채운 날(${withSessions.total})보다 크게 낮으면 안 된다`);

  // 시작해 놓고 다 놓아 버린 날은 그 사실이 점수에 남는다.
  const abandoned = cadenceScore({ ...base, focus: { started: 4, completion_rate: 0 } });
  assert.equal(abandoned.session_scored, true);
  assert.ok(abandoned.total < noSessions.total,
    `중단만 한 날(${abandoned.total})은 아예 안 쓴 날(${noSessions.total})보다 낮아야 한다`);
});
