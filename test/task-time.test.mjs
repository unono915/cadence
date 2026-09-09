import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('tasktime');
process.env.CADENCE_NO_TRACKER = '1';
process.env.CADENCE_PORT = '0';

/**
 * "이 태스크에 시간이 얼마나 들어갔나" 는 네 군데에서 따로 계산된다.
 *   1) 태스크 목록/상세      (server/api/tasks.mjs)
 *   2) 기간 리포트의 태스크별 (analytics.rangeReport)
 *   3) 프로젝트 집계          (analytics.projectTime)
 *   4) 추정 정확도            (analytics.estimateBias)
 *
 * 네 곳 모두 SQL 을 각자 적어 두고 있어서, 한 곳만 고치면 나머지와 조용히 어긋난다.
 * 실제로 4번은 "집중 세션 시간"만 세고 있었다 — 같은 태스크를 태스크 화면에서 보면
 * 12시간인데 리포트의 추정 정확도에서는 2시간으로 나오는 상태였고,
 * 어느 쪽이 맞는지 사용자가 알 방법이 없었다.
 *
 * 정의는 하나다: **집중 세션 시간 + 세션 구간과 겹치지 않는 태스크 연결 활동**.
 * 겹치는 부분을 두 번 세지 않는 것이 핵심이라, 일부러 겹치게 만들어 확인한다.
 */

const { server } = await import('../server/index.mjs');
const { run, get } = await import('../server/lib/db.mjs');
const { seedDefaults } = await import('../server/lib/categorize.mjs');
const { rangeReport, projectTime, estimateBias } = await import('../server/api/analytics.mjs');
const { getTask } = await import('../server/api/tasks.mjs');
const { dayKey, dayRange } = await import('../server/lib/time.mjs');

let BASE = '';
before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  const { db } = await import('../server/lib/db.mjs');
  db.close();
});

seedDefaults();

const DAY = '2026-04-15';
const day = dayKey(at(DAY, 10));
const deep = get("SELECT id FROM categories WHERE kind = 'deep'").id;

run(
  `INSERT INTO projects(name, color, archived, created_at, sort_order) VALUES ('시간 검증', '#5b8def', 0, ?, 0)`,
  at(DAY, 8),
);
const projectId = get('SELECT id FROM projects ORDER BY id DESC LIMIT 1').id;

run(
  `INSERT INTO tasks(project_id, title, notes, status, importance, urgency, estimate_min,
                     created_at, updated_at, completed_at)
   VALUES (?, '겹치는 시간 태스크', '', 'done', 1, 1, 60, ?, ?, ?)`,
  projectId, at(DAY, 8), at(DAY, 18), at(DAY, 18),
);
const taskId = get('SELECT id FROM tasks ORDER BY id DESC LIMIT 1').id;

// 10:00–10:30 집중 세션 (30분)
run(
  `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
   VALUES (?, 'focus', 30, ?, ?, 'completed', '', ?)`,
  taskId, at(DAY, 10), at(DAY, 10, 30), day,
);
// 세션 안에 들어가는 활동 20분 — 이미 세션으로 세었으므로 더해지면 안 된다.
run(
  `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
   VALUES ('Code', 'a.mjs', '', ?, ?, 1200, 0, ?, ?, ?)`,
  at(DAY, 10, 5), at(DAY, 10, 25), deep, taskId, day,
);
// 세션 밖의 활동 15분 — 이건 더해져야 한다.
run(
  `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
   VALUES ('Code', 'b.mjs', '', ?, ?, 900, 0, ?, ?, ?)`,
  at(DAY, 14), at(DAY, 14, 15), deep, taskId, day,
);
// 자리비움은 어디서도 세지 않는다.
run(
  `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
   VALUES ('(자리비움)', '', '', ?, ?, 1800, 1, NULL, ?, ?)`,
  at(DAY, 15), at(DAY, 15, 30), taskId, day,
);
// 휴식 세션은 업무 시간이 아니다.
run(
  `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
   VALUES (?, 'break', 10, ?, ?, 'completed', '', ?)`,
  taskId, at(DAY, 16), at(DAY, 16, 10), day,
);

const EXPECTED = 30 * 60 + 15 * 60; // 세션 30분 + 겹치지 않는 활동 15분

test('태스크 투입 시간이 네 경로에서 모두 같다', () => {
  const [from] = dayRange(day);
  const [, to] = dayRange(day);

  const fromTaskApi = getTask(taskId).actual_sec;
  const fromRange = rangeReport({ from: day, to: day }).by_task.find((t) => t.id === taskId).seconds;
  const fromProject = projectTime(from, to).find((p) => p.id === projectId).seconds;
  const bias = estimateBias(from, to).items.find((i) => i.id === taskId);

  assert.equal(fromTaskApi, EXPECTED, '태스크 목록의 실제 시간');
  assert.equal(fromRange, EXPECTED, '기간 리포트의 태스크별 시간');
  assert.equal(fromProject, EXPECTED, '프로젝트 집계');
  assert.equal(bias.actual_sec, EXPECTED, '추정 정확도의 실제 시간');
});

test('추정 정확도 배율도 같은 정의를 쓴다', () => {
  const [from] = dayRange(day);
  const [, to] = dayRange(day);
  const bias = estimateBias(from, to);
  assert.equal(bias.samples, 1);
  // 45분 실제 / 60분 예상 = 0.75배
  assert.equal(bias.items[0].ratio, 0.75);
  // 표본 하나짜리 "중앙값" 은 그냥 그 한 건이다. 경향처럼 읽히면 곤란하므로 내보내지 않는다 —
  // 예전에는 언제나 값을 돌려주고 부르는 쪽마다 표본 수를 다시 확인했는데,
  // 마크다운 내보내기가 그 확인을 빠뜨려 한 건짜리 배율이 주간보고에 실려 나갔다.
  assert.equal(bias.enough, false);
  assert.equal(bias.median_ratio, null);
});

test('겹치는 활동을 두 번 세지 않는다', async () => {
  // 세션 30분 + 세션 안 활동 20분 + 세션 밖 활동 15분 = 단순 합이면 65분.
  // 겹침을 빼면 45분이어야 한다.
  const res = await fetch(`${BASE}/api/tasks/${taskId}`);
  const task = await res.json();
  assert.equal(task.actual_sec, EXPECTED);
  assert.notEqual(task.actual_sec, 30 * 60 + 20 * 60 + 15 * 60);
  assert.equal(task.accuracy, 0.75);
});
