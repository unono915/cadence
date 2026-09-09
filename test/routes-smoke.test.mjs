import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('smoke');
process.env.CADENCE_NO_TRACKER = '1';

/**
 * 모든 GET 경로가 500 을 내지 않는지 한 번에 훑는다.
 *
 * 개별 검사는 자주 쓰는 화면만 덮는다. 실제로 깨지는 곳은 그 반대편 —
 * 리듬 리포트나 CSV 내보내기처럼 가끔 열어 보는 경로들이다. 함수 이름을 바꾸거나
 * 인자를 하나 늘리면 그쪽부터 조용히 죽는데, 아무도 눌러 보기 전까지 모른다.
 *
 * 경로 목록은 라우터에서 직접 받아 온다. 여기에 손으로 적어 두면 새 경로가
 * 생겨도 검사가 자라지 않아, 있으나 마나 한 그물이 된다.
 */

// 포트 0 = OS 가 비어 있는 포트를 골라 준다.
// 임의의 숫자를 뽑으면 검사 파일끼리 같은 포트를 집어 한쪽이 통째로 실패한다 —
// 그것도 가끔만, 그래서 원인을 찾기 어려운 방식으로.
process.env.CADENCE_PORT = '0';

const { buildRouter } = await import('../server/api/routes.mjs');
const { server } = await import('../server/index.mjs');
const { run, get } = await import('../server/lib/db.mjs');
const { dayKey } = await import('../server/lib/time.mjs');

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

// 빈 DB 만으로는 "행이 없어서 안 터진" 것과 구분되지 않는다. 최소한의 실데이터를 깐다.
const day = dayKey(at('2026-03-04', 10));
const category = get("SELECT id FROM categories WHERE kind = 'deep'").id;
run(
  `INSERT INTO projects(name, color, archived, created_at, sort_order, weekly_target_min)
   VALUES ('검사 프로젝트', '#5b8def', 0, ?, 0, 600)`,
  at('2026-03-04', 9),
);
const projectId = Number(get('SELECT id FROM projects ORDER BY id DESC LIMIT 1').id);
run(
  `INSERT INTO tasks(project_id, title, notes, status, importance, urgency, estimate_min,
                     created_at, updated_at, planned_for)
   VALUES (?, '검사 태스크', '', 'todo', 2, 2, 60, ?, ?, ?)`,
  projectId, at('2026-03-04', 9), at('2026-03-04', 9), day,
);
const taskId = Number(get('SELECT id FROM tasks ORDER BY id DESC LIMIT 1').id);
run(
  `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
   VALUES ('Code', 'main.mjs', 'code.exe', ?, ?, 3600, 0, ?, ?, ?)`,
  at('2026-03-04', 10), at('2026-03-04', 11), category, taskId, day,
);
run(
  `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
   VALUES (?, 'focus', 25, ?, ?, 'completed', '', ?)`,
  taskId, at('2026-03-04', 10), at('2026-03-04', 10, 25), day,
);
run(
  `INSERT INTO rules(field, pattern, is_regex, category_id, priority, created_at)
   VALUES ('app', 'Code', 0, ?, 90, ?)`,
  category, at('2026-03-04', 9),
);

const router = buildRouter();

/** 경로에 남은 자리표시자를 실제 값으로 채운다. */
function fill(pattern) {
  return pattern
    .replace(':id', String(taskId))
    .replace(/:\w+/g, '1');
}

/** 경로마다 필요한 필수 질의 인자. 없으면 400 이 정상이라 스모크의 뜻이 흐려진다. */
const QUERY = {
  '/api/activity/app': `?app=${encodeURIComponent('Code')}`,
  '/api/activity/title-suggestions': `?app=${encodeURIComponent('Code')}`,
  '/api/activity/manual/preview': `?started_at=${at('2026-03-04', 10)}&minutes=30`,
  '/api/activity/search': '?q=main',
  '/api/report/day': `?day=${day}`,
  '/api/report/week': `?day=${day}`,
  '/api/report/range': `?from=${day}&to=${day}`,
  '/api/export/day.md': `?day=${day}`,
  '/api/export/week.md': `?day=${day}`,
  '/api/export/range.md': `?from=${day}&to=${day}`,
  '/api/export/activity.csv': `?from=${day}&to=${day}`,
  '/api/notes': `?day=${day}`,
  '/api/activity/range': `?from=${at('2026-03-04', 9)}&to=${at('2026-03-04', 18)}`,
};

test('등록된 모든 GET 경로가 서버 오류 없이 응답한다', async (t) => {
  const gets = router.list().filter((r) => r.method === 'GET');
  assert.ok(gets.length >= 25, `GET 경로가 ${gets.length}개뿐입니다 — 라우터 목록이 비었을 수 있습니다`);

  const failures = [];
  for (const { pattern } of gets) {
    // 진단은 PowerShell 프로세스를 띄우므로 스모크에서 제외한다.
    if (pattern === '/api/tracker/diagnose') continue;

    const url = BASE + fill(pattern) + (QUERY[pattern] || '');
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      failures.push(`${pattern} → 요청 실패: ${err.message}`);
      continue;
    }
    const text = await res.text();
    if (res.status !== 200) {
      failures.push(`${pattern} → ${res.status} ${text.slice(0, 120)}`);
      continue;
    }
    // 200 인데 본문이 비어 있으면 대개 핸들러가 아무것도 돌려주지 않은 것이다.
    if (!text.length) failures.push(`${pattern} → 200 이지만 본문이 비었습니다`);
  }

  assert.deepEqual(failures, [], `실패한 경로: ${failures.join(' | ')}`);
  t.diagnostic(`GET 경로 ${gets.length}개 확인`);
});

test('모든 응답에 보안 헤더가 붙는다', async () => {
  // 헤더는 한 줄만 지워도 조용히 사라진다. 화면은 멀쩡히 뜨므로 아무도 알아채지 못한다.
  for (const path of ['/', '/app.js', '/api/health', '/없는경로']) {
    const res = await fetch(BASE + path);
    const csp = res.headers.get('content-security-policy') || '';
    assert.match(csp, /default-src 'none'/, `${path}: CSP 없음`);
    assert.match(csp, /script-src 'self'/, `${path}: script-src 가 느슨함`);
    assert.match(csp, /frame-ancestors 'none'/, `${path}: frame-ancestors 없음`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', `${path}: x-frame-options 없음`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${path}: referrer-policy 없음`);
    // 외부로 나가는 요청이 하나도 없는 앱이므로 여기가 열려 있을 이유가 없다.
    assert.doesNotMatch(csp, /connect-src[^;]*\*/, `${path}: connect-src 가 열려 있음`);
  }
});
