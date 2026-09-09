import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { useTempData } from './helpers.mjs';

useTempData('api');
process.env.CADENCE_NO_TRACKER = '1';
// 포트 0 = OS 가 비어 있는 포트를 골라 준다.
// 임의의 숫자를 뽑으면 검사 파일끼리 같은 포트를 집어 한쪽이 통째로 실패한다 —
// 그것도 가끔만, 그래서 원인을 찾기 어려운 방식으로.
process.env.CADENCE_PORT = '0';

const { server } = await import('../server/index.mjs');
let BASE = '';

before(async () => {
  if (!server.listening) {
    await new Promise((resolve) => server.once('listening', resolve));
  }
  BASE = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  const { db } = await import('../server/lib/db.mjs');
  db.close();
});

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, text };
}

/**
 * fetch 는 Host 헤더를 덮어쓰고 경로의 '..' 를 미리 정규화해 버린다.
 * 서버 쪽 방어를 진짜로 확인하려면 소켓에 요청을 직접 써야 한다.
 */
const CRLF = '\r\n';

function rawRequest(requestLine, headerLines = []) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      socket.write([requestLine, ...headerLines, 'Connection: close', '', ''].join(CRLF));
    });
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (c) => { buf += c; });
    socket.on('end', () => resolve(buf));
    socket.on('error', reject);
  });
}

test('health 는 서버와 추적기 상태를 돌려준다', async () => {
  const { status, data } = await call('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.today.match(/^\d{4}-\d{2}-\d{2}$/));
});

test('태스크 생성 → 조회 → 수정 → 완료 → 삭제', async () => {
  const created = await call('POST', '/api/tasks', {
    title: '설계 문서 검토', estimate_min: 45, importance: 2, urgency: 2,
  });
  assert.equal(created.status, 200);
  const id = created.data.id;
  assert.equal(created.data.quadrant, 1, '중요+긴급은 1사분면');

  const patched = await call('PATCH', `/api/tasks/${id}`, { status: 'done' });
  assert.equal(patched.data.status, 'done');
  assert.ok(patched.data.completed_at, '완료 시각이 자동으로 채워져야 한다');

  const reopened = await call('PATCH', `/api/tasks/${id}`, { status: 'todo' });
  assert.equal(reopened.data.completed_at, null, '되돌리면 완료 시각이 지워져야 한다');

  const listed = await call('GET', '/api/tasks');
  assert.ok(listed.data.some((t) => t.id === id));

  const removed = await call('DELETE', `/api/tasks/${id}`);
  assert.equal(removed.data.deleted, id);
  assert.equal((await call('GET', `/api/tasks/${id}`)).status, 404);
});

test('잘못된 입력은 400 과 한국어 메시지로 거절된다', async () => {
  const noTitle = await call('POST', '/api/tasks', {});
  assert.equal(noTitle.status, 400);
  assert.match(noTitle.data.error, /title/);

  const badRange = await call('POST', '/api/tasks', { title: 'x', importance: 9 });
  assert.equal(badRange.status, 400);

  const badStatus = await call('POST', '/api/tasks', { title: 'x', status: '진행중' });
  assert.equal(badStatus.status, 400);

  const badProject = await call('POST', '/api/tasks', { title: 'x', project_id: 99999 });
  assert.equal(badProject.status, 400);

  const tooLong = await call('POST', '/api/tasks', { title: 'x', notes: 'ㅁ'.repeat(9000) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.data.error, /notes/);
});

test('집중 세션은 한 번에 하나만 열린다', async () => {
  const task = (await call('POST', '/api/tasks', { title: '리팩터링' })).data;

  const first = (await call('POST', '/api/sessions', { task_id: task.id, planned_min: 25 })).data;
  assert.equal(first.status, 'running');

  const afterStart = (await call('GET', `/api/tasks/${task.id}`)).data;
  assert.equal(afterStart.status, 'doing', '세션을 시작하면 태스크가 진행 중으로 바뀐다');

  const second = (await call('POST', '/api/sessions', { planned_min: 15 })).data;
  const running = (await call('GET', '/api/sessions/running')).data;
  assert.equal(running.id, second.id);

  const closedFirst = (await call('GET', '/api/sessions')).data.find((s) => s.id === first.id);
  assert.equal(closedFirst.status, 'abandoned',
    '25분 중 몇 초 만에 다른 세션으로 옮겨 갔으므로 완주가 아니다');

  await call('POST', `/api/sessions/${second.id}/interrupt`);
  const bumped = (await call('POST', `/api/sessions/${second.id}/interrupt`)).data;
  assert.equal(bumped.interruptions, 2);

  await call('POST', `/api/sessions/${second.id}/end`, { status: 'abandoned' });
  assert.equal((await call('GET', '/api/sessions/running')).data, null);
});

test('완주는 계획한 시간을 채운 세션만 센다', async () => {
  // 종료 버튼이 상태를 붙이지 않으면 서버가 무조건 'done' 을 썼다. 그래서 25분을 계획하고
  // 12초 만에 끈 것도 완주로 남았고, 완주율은 언제나 100% 였다 — 항상 1.0 인 숫자는
  // 지표가 아니라 장식이다. 그런데 그 값이 Cadence 점수의 한 축이었다.
  const { db } = await import('../server/lib/db.mjs');

  // (1) 방금 시작해서 바로 끈 세션 → 중단
  const quick = (await call('POST', '/api/sessions', { planned_min: 25 })).data;
  assert.ok(quick.done_at > Date.now(), 'done_at 은 완주로 쳐 주는 시각이다');
  const endedQuick = (await call('POST', `/api/sessions/${quick.id}/end`, {})).data;
  assert.equal(endedQuick.status, 'abandoned');

  // (2) 계획의 8할을 넘긴 세션 → 완주.
  //     시작 시각을 뒤로 밀어 21분 지난 것처럼 만든다(25분의 84%).
  const long = (await call('POST', '/api/sessions', { planned_min: 25 })).data;
  db.prepare('UPDATE focus_sessions SET started_at = ? WHERE id = ?')
    .run(Date.now() - 21 * 60_000, long.id);
  const endedLong = (await call('POST', `/api/sessions/${long.id}/end`, {})).data;
  assert.equal(endedLong.status, 'done', '21/25분은 완주로 봐야 합니다');

  // (3) 사용자가 직접 말한 것은 그대로 따른다 — 자동 판단이 사람의 뜻을 덮으면 안 된다.
  const forced = (await call('POST', '/api/sessions', { planned_min: 25 })).data;
  db.prepare('UPDATE focus_sessions SET started_at = ? WHERE id = ?')
    .run(Date.now() - 24 * 60_000, forced.id);
  const endedForced = (await call('POST', `/api/sessions/${forced.id}/end`, { status: 'abandoned' })).data;
  assert.equal(endedForced.status, 'abandoned');

  // 뒤로 밀어 둔 세션들이 오늘 시간대를 덮고 있으면 다음 검사(세션 제안)가 흔들린다.
  db.prepare('DELETE FROM focus_sessions WHERE id IN (?, ?, ?)').run(quick.id, long.id, forced.id);
});

test('수동 시간 입력과 규칙 학습이 활동 기록에 반영된다', async () => {
  const categories = (await call('GET', '/api/categories')).data;
  const meeting = categories.find((c) => c.name === '회의');
  const { dayKey } = await import('../server/lib/time.mjs');

  // 시각은 **업무일 한가운데**로 잡는다. `Date.now()` 에서 한 시간을 빼면, 검사를 새벽
  // 04시 언저리에 돌릴 때 그 한 시간이 어제 업무일로 넘어가 오늘 요약에서 사라진다.
  // 검사가 도는 시각에 따라 결과가 달라지면 그건 검사가 아니다.
  const today = dayKey();
  const startedAt = Date.parse(`${today}T10:00:00`);
  const manual = await call('POST', '/api/activity/manual', {
    started_at: startedAt, minutes: 30, app: '팀 스탠드업', title: '', category_id: meeting.id,
  });
  assert.equal(manual.status, 200);
  assert.equal(manual.data.seconds, 1800);

  const summary = (await call('GET', '/api/activity/summary')).data;
  assert.ok(summary.by_app.some((a) => a.app === '팀 스탠드업'));

  // 자동 추적이 남긴 같은 이름의 기록 — 이쪽은 규칙이 정리해야 한다.
  const { db } = await import('../server/lib/db.mjs');
  const tracked = startedAt - 3600_000;
  const trackedId = Number(db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('팀 스탠드업', '', 'x.exe', ?, ?, 600, 0, NULL, ?)`,
  ).run(tracked, tracked + 600_000, dayKey(tracked)).lastInsertRowid);

  const dev = categories.find((c) => c.name === '개발');
  const taught = await call('POST', '/api/rules', {
    field: 'app', pattern: '팀 스탠드업', category_id: dev.id, apply_existing: true,
  });
  assert.equal(taught.data.updated, 1, '자동 추적 기록은 규칙을 따라 갱신된다');

  assert.equal(
    db.prepare('SELECT category_id FROM activity WHERE id = ?').get(trackedId).category_id,
    dev.id,
  );
  // 수동 입력은 사람이 "이 시간은 회의였다" 고 적어 둔 것이다.
  // 규칙 하나에 그것이 사라지면, 손으로 적는 일 자체가 무의미해진다.
  assert.equal(
    db.prepare('SELECT category_id FROM activity WHERE id = ?').get(manual.data.id).category_id,
    meeting.id,
    '손으로 고른 카테고리가 규칙 학습에 덮였습니다',
  );

  db.prepare('DELETE FROM activity WHERE id = ?').run(trackedId);
});

test('설정은 허용된 키만 받고 값을 검증한다', async () => {
  const ok = await call('PATCH', '/api/settings', { default_focus_min: 50 });
  assert.equal(ok.data.default_focus_min, '50');

  const unknown = await call('PATCH', '/api/settings', { rm_rf: '1' });
  assert.equal(unknown.status, 400);

  const outOfRange = await call('PATCH', '/api/settings', { day_start_hour: 30 });
  assert.equal(outOfRange.status, 400);
});

test('마크다운·CSV 내보내기가 동작한다', async () => {
  const md = await fetch(`${BASE}/api/export/day.md`);
  assert.equal(md.status, 200);
  assert.match(md.headers.get('content-type'), /markdown/);
  assert.match(await md.text(), /업무 요약/);

  const csv = await fetch(`${BASE}/api/export/activity.csv`);
  assert.match(await csv.text(), /day,start,end,seconds,app/);
});

test('루프백이 아닌 Host 헤더는 거부된다 (DNS 리바인딩 방어)', async () => {
  const blocked = await rawRequest('GET /api/health HTTP/1.1', ['Host: evil.example.com']);
  assert.match(blocked, /^HTTP\/1\.1 403/);

  const allowed = await rawRequest('GET /api/health HTTP/1.1', ['Host: localhost']);
  assert.match(allowed, /^HTTP\/1\.1 200/);
});

test('외부 오리진에서 온 요청은 거부된다', async () => {
  const res = await fetch(`${BASE}/api/health`, { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.status, 403);
});

test('루프백을 흉내 낸 이름들도 막힌다', async () => {
  // 허용 목록은 접두사/접미사가 아니라 정확히 일치해야 한다.
  // 'localhost.evil.com' 이나 '127.0.0.1.evil.com' 은 공격자가 실제로 등록할 수 있는 이름이다.
  for (const host of [
    'localhost.evil.com',
    '127.0.0.1.evil.com',
    'evil.com:80',
    'notlocalhost',
    '0.0.0.0',
    '127.0.0.2',
  ]) {
    const res = await rawRequest('GET /api/health HTTP/1.1', [`Host: ${host}`]);
    assert.match(res, /^HTTP\/1\.1 403/, `Host: ${host} 가 통과했습니다`);
  }

  // 대소문자와 포트는 정상으로 본다.
  for (const host of ['LOCALHOST', '127.0.0.1:9999', 'localhost:1']) {
    const res = await rawRequest('GET /api/health HTTP/1.1', [`Host: ${host}`]);
    assert.match(res, /^HTTP\/1\.1 200/, `Host: ${host} 가 막혔습니다`);
  }
});

test('출처를 숨긴 요청(Origin: null)도 막는다', async () => {
  // 샌드박스 iframe 과 file:// 페이지가 이렇게 보낸다 — 로컬 서버를 노리는 흔한 통로다.
  const res = await fetch(`${BASE}/api/health`, { headers: { origin: 'null' } });
  assert.equal(res.status, 403);

  // 반면 우리 화면에서 온 것은 통과한다.
  const ok = await fetch(`${BASE}/api/health`, {
    headers: { origin: `http://127.0.0.1:${server.address().port}` },
  });
  assert.equal(ok.status, 200);
});

test('정적 파일 경로 탈출로 소스가 새어 나가지 않는다', async () => {
  // 인코딩된 상위 경로, 원시 상위 경로, 백슬래시 — 어느 쪽으로도 web/ 밖은 못 나간다.
  for (const path of [
    '/%2e%2e/server/lib/db.mjs',
    '/../server/lib/db.mjs',
    '/..%5cserver%5clib%5cdb.mjs',
    '/%2e%2e%2f%2e%2e%2fpackage.json',
  ]) {
    const res = await rawRequest(`GET ${path} HTTP/1.1`, ['Host: 127.0.0.1']);
    assert.ok(
      !res.includes('DatabaseSync') && !res.includes('"name": "cadence"'),
      `${path} 로 파일 내용이 노출되면 안 된다`,
    );
  }
});

test('알 수 없는 API 경로는 404 JSON', async () => {
  const { status, data } = await call('GET', '/api/nope');
  assert.equal(status, 404);
  assert.ok(data.error);
});

test('오늘의 계획: planned_for 로 표시하고 리포트에 반영된다', async () => {
  const today = (await call('GET', '/api/health')).data.today;
  const a = (await call('POST', '/api/tasks', { title: '계획 A', estimate_min: 30 })).data;
  const b = (await call('POST', '/api/tasks', { title: '계획 B', estimate_min: 60 })).data;

  await call('PATCH', `/api/tasks/${a.id}`, { planned_for: today });
  await call('PATCH', `/api/tasks/${b.id}`, { planned_for: today });

  const planned = (await call('GET', `/api/tasks?planned_for=${today}&status=todo,doing,done`)).data;
  assert.equal(planned.length, 2);

  let report = (await call('GET', '/api/report/day')).data;
  assert.equal(report.tasks.planned, 2);
  assert.equal(report.tasks.planned_done, 0);
  assert.equal(report.tasks.planned_min, 90);

  await call('PATCH', `/api/tasks/${a.id}`, { status: 'done' });
  report = (await call('GET', '/api/report/day')).data;
  assert.equal(report.tasks.planned_done, 1);

  // 계획에서 빼기
  await call('PATCH', `/api/tasks/${b.id}`, { planned_for: null });
  report = (await call('GET', '/api/report/day')).data;
  assert.equal(report.tasks.planned, 1);

  const bad = await call('PATCH', `/api/tasks/${a.id}`, { planned_for: '2026/09/08' });
  assert.equal(bad.status, 400);
});

test('백업 내보내기 → 가져오기 왕복이 데이터를 보존한다', async () => {
  const before = (await call('GET', '/api/export/all.json')).data;
  const taskCount = before.tasks.length;
  assert.ok(taskCount > 0, '왕복을 확인하려면 데이터가 있어야 한다');

  // 데이터를 흐트러뜨린 뒤 복원한다.
  const victim = (await call('POST', '/api/tasks', { title: '삭제될 태스크' })).data;
  assert.equal((await call('GET', '/api/tasks')).data.some((t) => t.id === victim.id), true);

  const restored = await call('POST', '/api/import', { data: before, mode: 'replace' });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.counts.tasks, taskCount);
  assert.ok(restored.data.snapshot, '복원 전에 사본을 남겨야 한다');

  const after = (await call('GET', '/api/export/all.json')).data;
  assert.equal(after.tasks.length, taskCount, '복원 후 태스크 수가 백업과 같아야 한다');
  assert.equal(after.tasks.some((t) => t.id === victim.id), false, '백업에 없던 태스크는 사라져야 한다');
  assert.equal(after.activity.length, before.activity.length);
  assert.equal(after.categories.length, before.categories.length);
});

test('가져오기는 형식이 아닌 데이터를 거절한다', async () => {
  assert.equal((await call('POST', '/api/import', { data: { hello: 'world' } })).status, 400);
  assert.equal((await call('POST', '/api/import', { data: null })).status, 400);
  assert.equal((await call('POST', '/api/import', { data: { tasks: [] }, mode: '지우기' })).status, 400);
});

test('오래된 활동 기록 정리는 지정한 날짜 이전만 지운다', async () => {
  const today = (await call('GET', '/api/health')).data.today;
  const before = (await call('GET', '/api/storage')).data.activity.n;

  // 아주 오래된 기록 하나를 심는다.
  const old = Date.now() - 400 * 86_400_000;
  const cats = (await call('GET', '/api/categories')).data;
  await call('POST', '/api/activity/manual', {
    started_at: old, minutes: 10, app: '옛날 작업', title: '', category_id: cats[0].id,
  });
  assert.equal((await call('GET', '/api/storage')).data.activity.n, before + 1);

  const cutoff = `${new Date(Date.now() - 200 * 86_400_000).getFullYear()}-01-01`;
  const res = await call('POST', '/api/storage/prune', { before_day: cutoff });
  assert.ok(res.data.deleted >= 1);

  const stats = (await call('GET', '/api/storage')).data;
  assert.ok(!stats.activity.first_day || stats.activity.first_day >= cutoff);

  assert.equal((await call('POST', '/api/storage/prune', { before_day: '어제' })).status, 400);
});

test('긴 자리비움 되묻기: 목록 → 실제 활동으로 전환 / 무시', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const base = Date.now() - 4 * 3600_000;

  const insertIdle = (offsetMin, minutes) => db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
     VALUES ('(자리비움)', '', '', ?, ?, ?, 1, ?)`,
  ).run(base + offsetMin * 60_000, base + (offsetMin + minutes) * 60_000, minutes * 60, today);

  insertIdle(0, 40);   // 길다 — 물어봐야 한다
  insertIdle(60, 30);  // 길다
  insertIdle(120, 5);  // 짧다 — 묻지 않는다

  const gaps = (await call('GET', `/api/activity/gaps?day=${today}&min_sec=900`)).data;
  assert.equal(gaps.length, 2, '15분 이상인 구간만 묻는다');

  const cats = (await call('GET', '/api/categories')).data;
  const meeting = cats.find((c) => c.name === '회의');

  const resolved = await call('POST', `/api/activity/${gaps[0].id}/resolve`, {
    app: '주간 회의', category_id: meeting.id,
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.idle, 0);
  assert.equal(resolved.data.category_name, '회의');

  // 회의로 바뀌었으니 리포트의 회의 시간에 잡혀야 한다.
  const report = (await call('GET', `/api/report/day?day=${today}`)).data;
  assert.ok((report.kinds.meeting || 0) >= 40 * 60);

  await call('POST', `/api/activity/${gaps[1].id}/resolve`, { ignore: true });
  const left = (await call('GET', `/api/activity/gaps?day=${today}&min_sec=900`)).data;
  assert.equal(left.length, 0, '확인한 구간은 다시 묻지 않는다');

  // 자리비움이 아닌 기록은 이 경로로 처리할 수 없다.
  const normal = (await call('GET', `/api/activity?day=${today}&min_sec=0`)).data
    .find((a) => a.idle === 0);
  const rejected = await call('POST', `/api/activity/${normal.id}/resolve`, { ignore: true });
  assert.equal(rejected.status, 400);
});

test('프로젝트 주간 목표와 투입 시간 집계', async () => {
  const project = (await call('POST', '/api/projects', {
    name: '예산 프로젝트', color: '#4f9d69', weekly_target_min: 600,
  })).data;
  assert.equal(project.weekly_target_min, 600);

  const task = (await call('POST', '/api/tasks', {
    title: '예산 태스크', project_id: project.id,
  })).data;

  // 세션 시간과, 세션과 겹치지 않는 추적 시간이 함께 잡혀야 한다.
  const session = (await call('POST', '/api/sessions', { task_id: task.id, planned_min: 25 })).data;
  await call('POST', `/api/sessions/${session.id}/end`, { status: 'done' });

  const cats = (await call('GET', '/api/categories')).data;
  const manual = (await call('POST', '/api/activity/manual', {
    started_at: Date.now() - 2 * 3600_000, minutes: 45,
    app: '오프라인 검토', title: '', category_id: cats[0].id, task_id: task.id,
  })).data;
  assert.equal(manual.task_id, task.id);

  const week = (await call('GET', '/api/report/week')).data;
  const row = week.by_project.find((p) => p.id === project.id);
  assert.ok(row, '프로젝트가 주간 리포트에 나타나야 한다');
  assert.equal(row.target_sec, 600 * 60);
  assert.ok(row.tracked_sec >= 45 * 60, `수동 기록이 반영되어야 한다 (${row.tracked_sec})`);
  assert.equal(row.seconds, row.session_sec + row.tracked_sec);
  assert.equal(row.ratio, Number((row.seconds / row.target_sec).toFixed(2)));

  // 목표만 있고 실적이 없는 프로젝트도 예산 비교를 위해 남는다.
  const empty = (await call('POST', '/api/projects', {
    name: '아직 시작 안 한 프로젝트', weekly_target_min: 120,
  })).data;
  const week2 = (await call('GET', '/api/report/week')).data;
  const emptyRow = week2.by_project.find((p) => p.id === empty.id);
  assert.ok(emptyRow, '목표가 있으면 실적 0이어도 목록에 남는다');
  assert.equal(emptyRow.seconds, 0);

  // 목표 없이 실적도 없는 프로젝트는 빠진다.
  const quiet = (await call('POST', '/api/projects', { name: '조용한 프로젝트' })).data;
  const week3 = (await call('GET', '/api/report/week')).data;
  assert.equal(week3.by_project.some((p) => p.id === quiet.id), false);

  // 범위를 벗어난 목표는 거절된다.
  assert.equal((await call('PATCH', `/api/projects/${project.id}`, { weekly_target_min: 1 })).status, 400);
  // null 로 목표를 지울 수 있다.
  const cleared = (await call('PATCH', `/api/projects/${project.id}`, { weekly_target_min: null })).data;
  assert.equal(cleared.weekly_target_min, null);
});

test('세션 없이 몰입한 구간을 감지해 기록으로 남길 수 있다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');

  // 앞선 테스트들이 남긴 오늘 기록을 치워 이 검사만 남긴다.
  db.prepare('DELETE FROM activity WHERE day = ?').run(today);

  // 진행 중인 세션이 있으면 제안하지 않는다.
  const running = (await call('POST', '/api/sessions', { planned_min: 25 })).data;
  assert.equal((await call('GET', '/api/sessions/suggest')).data, null);
  await call('POST', `/api/sessions/${running.id}/end`, { status: 'done' });

  // 방금 끝난 40분짜리 몰입 구간을 심는다 (세션과 겹치지 않는 시간대).
  const end = Date.now() - 60_000;
  const start = end - 40 * 60_000;
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Visual Studio Code', '', '', ?, ?, ?, 0, ?, ?)`,
  ).run(start, end, Math.round((end - start) / 1000), dev.id, today);

  const suggestion = (await call('GET', '/api/sessions/suggest')).data;
  assert.ok(suggestion, '방금 끝난 몰입 구간을 제안해야 한다');
  assert.equal(suggestion.minutes, 40);
  assert.equal(suggestion.top_app, 'Visual Studio Code');

  const recorded = (await call('POST', '/api/sessions/record', {
    start: suggestion.start, end: suggestion.end,
  })).data;
  assert.equal(recorded.status, 'done');
  assert.equal(recorded.planned_min, 40);

  // 이미 세션으로 기록된 구간은 다시 제안하지 않는다.
  assert.equal((await call('GET', '/api/sessions/suggest')).data, null);

  // 뒤집힌 구간은 거절된다.
  const bad = await call('POST', '/api/sessions/record', { start: end, end: start });
  assert.equal(bad.status, 400);
});

test('주간 비교는 지난주의 같은 일수와 맞춰 계산한다', async () => {
  const week = (await call('GET', '/api/report/week')).data;
  assert.ok(week.elapsed_days >= 1 && week.elapsed_days <= 7);
  assert.equal(week.previous.compared_days, week.elapsed_days);
  assert.equal(week.previous.days.length, week.elapsed_days);
  assert.equal(week.complete, week.elapsed_days >= 7);

  // 지난 주를 조회하면 이미 끝난 주이므로 7일 전체가 비교 대상이 된다.
  const lastWeekDay = week.previous.days[0];
  const past = (await call('GET', `/api/report/week?day=${lastWeekDay}`)).data;
  assert.equal(past.complete, true);
  assert.equal(past.previous.compared_days, 7);
});

test('활동 검색은 창 제목과 앱 이름을 함께 뒤지고 날짜별로 접는다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey, shiftDay } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const cats = (await call('GET', '/api/categories')).data;
  const doc = cats.find((c) => c.name === '문서·작성');

  const insert = (day, app, title, minutes) => {
    const start = Date.now() - 3 * 3600_000;
    db.prepare(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES (?, ?, '', ?, ?, ?, 0, ?, ?)`,
    ).run(app, title, start, start + minutes * 60_000, minutes * 60, doc.id, day);
  };

  insert(today, 'Microsoft Word', '분기 보고서 초안.docx', 30);
  insert(shiftDay(today, -1), 'Microsoft Word', '분기 보고서.docx', 45);
  insert(shiftDay(today, -2), 'Notepad', '메모', 10);

  const found = (await call('GET', '/api/activity/search?q=' + encodeURIComponent('분기 보고서'))).data;
  assert.equal(found.matches, 2);
  assert.equal(found.days.length, 2);
  assert.equal(found.total_sec, 75 * 60);
  assert.equal(found.days[0].day, today, '최근 날짜가 먼저 온다');

  // 앱 이름으로도 찾힌다.
  const byApp = (await call('GET', '/api/activity/search?q=Notepad')).data;
  assert.equal(byApp.matches, 1);

  // 기간을 좁힐 수 있다.
  const narrowed = (await call(
    'GET',
    `/api/activity/search?q=${encodeURIComponent('분기 보고서')}&from=${today}`,
  )).data;
  assert.equal(narrowed.matches, 1);

  // 빈 검색어는 거절된다.
  assert.equal((await call('GET', '/api/activity/search?q=')).status, 400);
});

test('카테고리 추가·수정·삭제와 기본값 보호', async () => {
  const created = (await call('POST', '/api/categories', {
    name: '고객 응대', kind: 'comms', color: '#3fa9a0',
  })).data;
  assert.equal(created.name, '고객 응대');
  assert.equal(created.kind, 'comms');

  // 같은 이름은 두 번 만들 수 없다.
  assert.equal((await call('POST', '/api/categories', { name: '고객 응대', kind: 'comms' })).status, 400);
  // 알 수 없는 종류는 거절된다.
  assert.equal((await call('POST', '/api/categories', { name: '무엇', kind: '몰입' })).status, 400);

  const renamed = (await call('PATCH', `/api/categories/${created.id}`, {
    name: '고객 대응', kind: 'shallow',
  })).data;
  assert.equal(renamed.name, '고객 대응');
  assert.equal(renamed.kind, 'shallow');

  // 이 카테고리로 분류된 기록을 만들고, 삭제 시 기록이 남는지 확인한다.
  const manual = (await call('POST', '/api/activity/manual', {
    started_at: Date.now() - 30 * 60_000, minutes: 20,
    app: '고객 통화', title: '', category_id: created.id,
  })).data;
  assert.equal(manual.category_id, created.id);

  const removed = (await call('DELETE', `/api/categories/${created.id}`)).data;
  assert.equal(removed.unclassified, 1);

  const after = (await call('GET', `/api/activity?day=${manual.day}&min_sec=0`)).data
    .find((a) => a.id === manual.id);
  assert.ok(after, '카테고리를 지워도 활동 기록 자체는 남는다');
  assert.equal(after.category_id, null);

  // 마지막 '미분류'는 분류 실패 시의 기본값이므로 지우거나 종류를 바꿀 수 없다.
  const fallback = (await call('GET', '/api/categories')).data.find((c) => c.kind === 'other');
  assert.equal((await call('DELETE', `/api/categories/${fallback.id}`)).status, 400);
  assert.equal((await call('PATCH', `/api/categories/${fallback.id}`, { kind: 'deep' })).status, 400);
  // 이름과 색은 바꿀 수 있다.
  assert.equal((await call('PATCH', `/api/categories/${fallback.id}`, { name: '기타' })).data.name, '기타');
});

test('무결성 점검은 어중간한 행을 찾아내고, 고치기는 사본을 남긴 뒤 실행된다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const now = Date.now();

  // 활동 기록을 통째로 치우고 시작한다.
  //
  // 이 검사는 DB 전체를 훑는 수리를 돌린다. 앞선 검사가 남긴 행이 하나라도 있으면
  // 여기서 심는 행과 시간대가 겹쳐 '겹침' 수리에 먼저 걸려 지워지고, 정작 보려던 것이
  // 사라진다. 날짜만 골라 지우는 것으로는 모자랐다 — 행의 `day` 칸과 실제 시각이
  // 어긋나 있는 경우가 바로 이 검사가 만들어 내는 상황이기 때문이다.
  db.prepare('DELETE FROM activity').run();

  const insert = (started, ended, seconds, day) => db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
     VALUES ('깨진 기록', '', '', ?, ?, ?, 0, ?)`,
  ).run(started, ended, seconds, day).lastInsertRowid;

  // 시각이 서로 겹치지도 같지도 않게 띄운다 — 겹치면 '중복'이나 '겹침' 항목에 먼저 걸려
  // 이 검사가 보려는 것(어중간한 행 하나하나)이 흐려진다.
  //
  // 기준은 `Date.now()` 가 아니라 **업무일 한가운데**로 잡는다. 전에는 now 에서 몇 시간씩
  // 더해 썼는데, 새벽 1시에 돌리면 now+3h 가 업무일 경계(04:00)를 넘어 다음 날이 되고
  // "날짜 표기를 시각 기준으로 맞춘다" 는 마지막 확인이 하루 어긋나 실패했다.
  // 검사가 도는 시각에 따라 결과가 달라지면 그건 검사가 아니다.
  const H = 3600_000;
  const base = Date.parse(`${today}T09:00:00`);
  const reversed = insert(base, base - 60_000, 60, today);                    // 끝이 시작보다 이름
  const mismatch = insert(base + H, base + H + 600_000, 5, today);            // 길이가 안 맞음 (실제 600초)
  const zero = insert(base + 2 * H, base + 2 * H, 0, today);                  // 길이 0
  const wrongDay = insert(base + 3 * H, base + 3 * H + 57_000, 57, '2000-01-01'); // 날짜 표기가 어긋남

  const stale = db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, status, note, day)
     VALUES (NULL, 'focus', 25, ?, 'running', '', ?)`,
  ).run(now - 3 * 86_400_000, today).lastInsertRowid;

  const check = (await call('GET', '/api/storage/integrity')).data;
  assert.equal(check.ok, false);
  const keys = check.issues.map((i) => i.key);
  for (const k of ['reversed', 'seconds_mismatch', 'zero_length', 'orphan_day', 'running_stale']) {
    assert.ok(keys.includes(k), `${k} 를 찾아내야 한다`);
  }

  const fixed = (await call('POST', '/api/storage/repair')).data;
  assert.ok(fixed.snapshot, '고치기 전에 사본을 남겨야 한다');
  assert.equal(fixed.ok, true, `고친 뒤에는 문제가 없어야 한다: ${JSON.stringify(fixed.issues)}`);

  const row = (id) => db.prepare('SELECT * FROM activity WHERE id = ?').get(id);
  assert.equal(row(reversed), undefined, '뒤집힌 구간은 쓸 정보가 없으므로 지운다');
  assert.equal(row(zero), undefined, '길이 0 인 기록도 지운다');
  assert.equal(row(mismatch).seconds, 600, '길이는 시각으로 다시 계산한다');
  assert.equal(row(wrongDay).day, today, '날짜 표기는 시각 기준으로 맞춘다');

  const session = db.prepare('SELECT * FROM focus_sessions WHERE id = ?').get(stale);
  assert.equal(session.status, 'abandoned');
  assert.equal(session.ended_at, session.started_at + 25 * 60_000, '계획한 시간만큼만 인정한다');

  // 문제가 없으면 사본을 남기지 않는다.
  const again = (await call('POST', '/api/storage/repair')).data;
  assert.equal(again.snapshot, null);
});

test('추적기 설정은 저장 즉시 실행 중인 추적기에 반영된다', async () => {
  const before = (await call('GET', '/api/tracker')).data;

  const saved = (await call('PATCH', '/api/settings', {
    tracker_idle_s: 300, tracker_poll_ms: 6000,
  })).data;
  assert.equal(saved.tracker_idle_s, '300');
  assert.equal(saved.tracker_poll_ms, '6000');

  const after = (await call('GET', '/api/tracker')).data;
  assert.equal(after.idleThresholdS, 300, '유휴 임계값이 즉시 반영되어야 한다');
  assert.equal(after.pollMs, 6000, '폴링 주기가 반영되어야 한다');

  // 범위를 벗어난 값은 거절되고 기존 값이 유지된다.
  assert.equal((await call('PATCH', '/api/settings', { tracker_poll_ms: 100 })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { tracker_idle_s: 5 })).status, 400);
  assert.equal((await call('GET', '/api/tracker')).data.pollMs, 6000);

  await call('PATCH', '/api/settings', {
    tracker_idle_s: before.idleThresholdS, tracker_poll_ms: before.pollMs,
  });
});

test('주간 리뷰 완료 시점은 설정에 남고 형식을 검사한다', async () => {
  const initial = (await call('GET', '/api/settings')).data;
  assert.equal(initial.last_weekly_review, '');

  const saved = (await call('PATCH', '/api/settings', { last_weekly_review: '2026-08-31' })).data;
  assert.equal(saved.last_weekly_review, '2026-08-31');

  // 빈 문자열로 지울 수 있다 — 안내를 다시 받고 싶을 때.
  assert.equal((await call('PATCH', '/api/settings', { last_weekly_review: '' })).data.last_weekly_review, '');

  // 형식이 틀리면 거절된다.
  assert.equal((await call('PATCH', '/api/settings', { last_weekly_review: '지난주' })).status, 400);
});

test('분류 규칙은 수정할 수 있고 정규식은 검증된다', async () => {
  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');
  const comms = cats.find((c) => c.name === '커뮤니케이션');

  await call('POST', '/api/rules', {
    field: 'title', pattern: '규칙시험문구', category_id: dev.id, priority: 55, apply_existing: false,
  });
  const rule = (await call('GET', '/api/rules')).data.find((r) => r.pattern === '규칙시험문구');
  assert.ok(rule);
  assert.equal(rule.priority, 55);

  const patched = (await call('PATCH', `/api/rules/${rule.id}`, {
    priority: 12, category_id: comms.id, field: 'app',
  })).data;
  assert.equal(patched.priority, 12);
  assert.equal(patched.category_id, comms.id);
  assert.equal(patched.field, 'app');

  // 범위 밖 우선순위, 없는 카테고리, 잘못된 대상은 거절된다.
  assert.equal((await call('PATCH', `/api/rules/${rule.id}`, { priority: 0 })).status, 400);
  assert.equal((await call('PATCH', `/api/rules/${rule.id}`, { category_id: 99999 })).status, 400);
  assert.equal((await call('PATCH', `/api/rules/${rule.id}`, { field: '제목' })).status, 400);

  // 정규식으로 바꾸면 컴파일 가능한지 확인한다.
  assert.equal((await call('PATCH', `/api/rules/${rule.id}`, {
    pattern: '[unclosed', is_regex: true,
  })).status, 400);
  const asRegex = (await call('PATCH', `/api/rules/${rule.id}`, {
    pattern: '규칙(시험|검증)', is_regex: true,
  })).data;
  assert.equal(asRegex.is_regex, 1);

  await call('DELETE', `/api/rules/${rule.id}`);
  assert.equal((await call('GET', '/api/rules')).data.some((r) => r.id === rule.id), false);
});

test('정규식 규칙도 기존 기록에 적용된다', async () => {
  const cats = (await call('GET', '/api/categories')).data;
  const study = cats.find((c) => c.name === '학습');

  // 시각은 **업무일 한가운데**로 잡는다.
  //
  // 예전에는 '5시간 전'을 썼는데, 새벽 4시 언저리에 돌리면 세 줄이 업무일 경계를 넘어
  // **서로 다른 날**로 흩어졌다. 그러면 마지막 줄의 날짜로 조회하게 되어 앞의 두 줄이
  // 안 보이고, 검사는 "정규식이 안 먹었다" 고 말한다 — 실제로는 정규식과 아무 상관이 없다.
  const { dayKey: dk } = await import('../server/lib/time.mjs');
  const base = Date.parse(`${dk()}T20:00:00`);
  let day = null;
  // 수동 입력은 겹치는 구간을 대신하므로, 서로 다른 시간대에 넣는다.
  const apps = ['정규식대상A', '정규식대상B', '무관한앱'];
  for (let i = 0; i < apps.length; i++) {
    const row = (await call('POST', '/api/activity/manual', {
      started_at: base + i * 15 * 60_000, minutes: 10, app: apps[i], title: '',
    })).data;
    day = row.day;
  }

  const res = (await call('POST', '/api/rules', {
    field: 'app', pattern: '^정규식대상', is_regex: true, category_id: study.id, apply_existing: true,
  })).data;
  assert.equal(res.updated, 2, '정규식에 맞는 두 건만 갱신되어야 한다');

  const summary = (await call('GET', `/api/activity/summary?day=${day}`)).data;
  assert.equal(summary.by_app.find((a) => a.app === '정규식대상A').category_name, '학습');
  assert.notEqual(summary.by_app.find((a) => a.app === '무관한앱').category_name, '학습');
});

test('기간 리포트는 임의 구간의 프로젝트·태스크 시간을 합친다', async () => {
  const { dayKey, shiftDay } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const from = shiftDay(today, -3);

  const project = (await call('POST', '/api/projects', { name: '기간시험 프로젝트' })).data;
  const task = (await call('POST', '/api/tasks', {
    title: '기간시험 태스크', project_id: project.id, estimate_min: 60,
  })).data;

  // 기간 안: 어제 2시간, 기간 밖: 10일 전 3시간
  const inside = (await call('POST', '/api/activity/manual', {
    started_at: Date.now() - 26 * 3600_000, minutes: 120,
    app: '기간시험 작업', title: '', task_id: task.id,
  })).data;
  await call('POST', '/api/activity/manual', {
    started_at: Date.now() - 10 * 86_400_000, minutes: 180,
    app: '오래된 작업', title: '', task_id: task.id,
  });

  const r = (await call('GET', `/api/report/range?from=${from}&to=${today}`)).data;
  assert.equal(r.from, from);
  assert.equal(r.to, today);

  const proj = r.by_project.find((p) => p.id === project.id);
  assert.ok(proj, '프로젝트가 집계에 나타나야 한다');
  assert.equal(proj.seconds, 120 * 60, '기간 밖 기록은 빠져야 한다');

  const row = r.by_task.find((t) => t.id === task.id);
  assert.equal(row.seconds, 120 * 60);
  assert.equal(row.project_name, '기간시험 프로젝트');

  // 기간을 넓히면 예전 기록도 포함된다.
  const wide = (await call('GET', `/api/report/range?from=${shiftDay(today, -30)}&to=${today}`)).data;
  assert.equal(wide.by_task.find((t) => t.id === task.id).seconds, 300 * 60);

  // 뒤집힌 기간은 거절된다.
  assert.equal((await call('GET', `/api/report/range?from=${today}&to=${from}`)).status, 400);
  assert.equal((await call('GET', '/api/report/range?from=어제')).status, 400);

  // 내보내기도 같은 숫자를 낸다.
  const md = await (await fetch(`${BASE}/api/export/range.md?from=${from}&to=${today}`)).text();
  assert.match(md, /기간 리포트/);
  assert.match(md, /기간시험 프로젝트/);

  const csv = await (await fetch(`${BASE}/api/export/tasks.csv?from=${from}&to=${today}`)).text();
  assert.match(csv, /from,to,project,task,status,estimate_min/);
  assert.match(csv, /기간시험 태스크/);
  assert.match(csv, /,120$|,120\r?\n/m);

  assert.ok(inside.task_id === task.id);
});

test('시작 시각과 내용이 같은 중복 기록을 정리하고 가장 긴 끝 시각을 남긴다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  // 시각은 **업무일 한가운데**로 잡는다. '2시간 전' 은 새벽에 돌리면 업무일 경계를 넘어
  // `day` 칸과 실제 시각이 어긋나고, 그러면 이 검사가 보려던 '중복' 대신
  // '날짜 어긋남' 이 먼저 걸려 마지막 확인이 실패한다.
  const start = Date.parse(`${today}T17:00:00`);
  // 이 시간대에 다른 검사가 남긴 것이 있으면 '겹침' 으로 잡히므로 비워 두고 시작한다.
  db.prepare('DELETE FROM activity WHERE started_at < ? AND ended_at > ?')
    .run(start + 3 * 3600_000, start - 3600_000);

  // 예전 판의 재시작 버그가 만들던 모양: 같은 시작 시각, 같은 내용, 끝만 다름
  const ids = [30, 45, 60].map((min) => Number(db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
     VALUES ('(자리비움)', '', '', ?, ?, ?, 1, ?)`,
  ).run(start, start + min * 60_000, min * 60, today).lastInsertRowid));

  const check = (await call('GET', '/api/storage/integrity')).data;
  const issue = check.issues.find((i) => i.key === 'duplicate');
  assert.ok(issue, '중복을 찾아내야 한다');
  assert.equal(issue.count, 2, '세 행 중 두 개가 중복');

  const fixed = (await call('POST', '/api/storage/repair')).data;
  assert.equal(fixed.repaired.duplicate, 2);

  const rows = db.prepare(
    'SELECT id, ended_at, seconds FROM activity WHERE started_at = ? AND idle = 1',
  ).all(start);
  assert.equal(rows.length, 1, '하나만 남아야 한다');
  assert.equal(rows[0].id, Math.min(...ids), '가장 먼저 기록된 행을 남긴다');
  assert.equal(rows[0].ended_at, start + 60 * 60_000, '끝 시각은 가장 늦은 값으로');
  assert.equal(rows[0].seconds, 3600);

  assert.equal((await call('GET', '/api/storage/integrity')).data.ok, true);
});

test('미분류 앱 목록은 시간이 큰 것부터 보여주고 규칙을 만들면 사라진다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const base = Date.now() - 6 * 3600_000;

  db.prepare('DELETE FROM activity WHERE day = ?').run(today);

  const insert = (app, title, minutes, offsetH, categoryId = null) => db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, ?, '', ?, ?, ?, 0, ?, ?)`,
  ).run(app, title, base + offsetH * 3600_000, base + offsetH * 3600_000 + minutes * 60_000,
    minutes * 60, categoryId, today);

  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');

  insert('사내 그룹웨어', '전자결재', 40, 0);
  insert('낯선 도구', '', 25, 1);
  insert('아주 잠깐 쓴 것', '', 2, 2);       // 5분 미만이라 목록에서 빠진다
  insert('Visual Studio Code', 'a.js', 60, 3, dev.id); // 이미 분류됨

  const before = (await call('GET', '/api/activity/unclassified?days=1')).data;
  assert.deepEqual(before.apps.map((a) => a.app), ['사내 그룹웨어', '낯선 도구'],
    '시간 순, 그리고 짧은 것과 이미 분류된 것은 빠져야 한다');
  assert.equal(before.apps[0].sample_title, '전자결재', '무엇이었는지 실마리를 함께 준다');
  assert.equal(before.unclassified_sec, 67 * 60, '짧은 것도 합계에는 들어간다');
  assert.equal(before.ratio, Number((67 / 127).toFixed(3)));

  // 규칙 하나로 과거까지 정리된다.
  const taught = (await call('POST', '/api/rules', {
    field: 'app', pattern: '사내 그룹웨어', category_id: dev.id, apply_existing: true,
  })).data;
  assert.equal(taught.updated, 1);

  const after = (await call('GET', '/api/activity/unclassified?days=1')).data;
  assert.deepEqual(after.apps.map((a) => a.app), ['낯선 도구']);
  assert.ok(after.unclassified_sec < before.unclassified_sec);

  // 기간과 최소 시간은 검증된다.
  assert.equal((await call('GET', '/api/activity/unclassified?days=0')).status, 400);
  assert.equal((await call('GET', '/api/activity/unclassified?days=1&min_sec=100000')).status, 400);
});

test('자리비움 정리 버튼은 그 사람이 실제로 쓴 이름표를 배운다', async () => {
  // 자리를 비우는 이유는 직업마다 다르다 — 교사에게는 대부분이 '수업' 이다.
  // 기본 넷만 두면 그런 사람은 매번 "직접 입력" 을 눌러 같은 말을 다시 적어야 하고,
  // 하루에 여덟 구간이면 그 순간 이 기능은 안 쓰이게 된다.
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  db.prepare("DELETE FROM activity WHERE exe = 'resolved'").run();

  const cats = (await call('GET', '/api/categories')).data;
  const meeting = cats.find((c) => c.name === '회의');
  const study = cats.find((c) => c.name === '학습');

  assert.deepEqual((await call('GET', '/api/activity/gap-labels')).data, [],
    '기록이 없으면 배울 것도 없다');

  // 자리비움 세 구간을 만들고, 두 번은 '수업' 으로 한 번은 '학부모 상담' 으로 정리한다.
  const gapAt = (hour) => {
    const from = Date.parse(`${today}T0${hour}:00:00`);
    return Number(db.prepare(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
       VALUES ('(자리비움)', '', '', ?, ?, 3600, 1, ?)`,
    ).run(from, from + 3600_000, today).lastInsertRowid);
  };
  for (const hour of [1, 2]) {
    await call('POST', `/api/activity/${gapAt(hour)}/resolve`, { app: '수업', category_id: meeting.id });
  }
  await call('POST', `/api/activity/${gapAt(3)}/resolve`, { app: '학부모 상담', category_id: study.id });

  const labels = (await call('GET', '/api/activity/gap-labels')).data;
  assert.deepEqual(labels.map((l) => l.app), ['수업', '학부모 상담'], '많이 쓴 것이 앞에 와야 한다');
  assert.equal(labels[0].uses, 2);
  assert.equal(labels[0].category_id, meeting.id);
  assert.equal(labels[0].category_name, '회의');

  // 카테고리가 사라진 이름표는 주지 않는다 — 눌러도 미분류가 되는 버튼은 없느니만 못하다.
  await call('DELETE', `/api/categories/${study.id}`);
  const after = (await call('GET', '/api/activity/gap-labels')).data;
  assert.deepEqual(after.map((l) => l.app), ['수업']);

  db.prepare("DELETE FROM activity WHERE exe = 'resolved'").run();
});

test('제목별 정리 목록에는 아직 분류되지 않은 제목만 오른다', async () => {
  // 정리하러 들어온 사람에게 이미 정리된 줄을 보여 주면, 가장 값진 클릭 몇 번을
  // 아무것도 바꾸지 않는 데 쓰게 된다. 실제로 Chrome 여덟 줄 중 셋이 그랬다.
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const base = Date.now() - 6 * 3600_000;
  db.prepare('DELETE FROM activity WHERE day = ?').run(today);

  const cats = (await call('GET', '/api/categories')).data;
  const comms = cats.find((c) => c.name === '커뮤니케이션');

  const insert = (title, minutes, offsetH, categoryId = null) => db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('브라우저', ?, '', ?, ?, ?, 0, ?, ?)`,
  ).run(title, base + offsetH * 3600_000, base + offsetH * 3600_000 + minutes * 60_000,
    minutes * 60, categoryId, today);

  insert('사내 위키 - 브라우저', 30, 0);
  insert('보고서 초안 - 브라우저', 20, 1);
  insert('받은편지함 - 브라우저', 40, 2, comms.id); // 이미 분류됨 — 가장 길지만 빠져야 한다
  insert('회의록 - 브라우저', 10, 3);
  insert('공지 - 브라우저', 8, 4, comms.id);        // 이미 분류됨

  const app = (await call('GET', '/api/activity/unclassified?days=1')).data.apps
    .find((a) => a.app === '브라우저');
  assert.ok(app, '브라우저가 목록에 없습니다');

  assert.deepEqual(app.top_titles.map((t) => t.title),
    ['사내 위키 - 브라우저', '보고서 초안 - 브라우저', '회의록 - 브라우저'],
    '이미 분류된 제목이 정리 목록에 남아 있습니다');
  assert.equal(app.sample_title, '사내 위키 - 브라우저');

  // 제목 목록의 합계는 이 앱의 미분류 시간과 맞아야 한다 — 화면의 두 숫자가 어긋나면
  // 사용자는 어느 쪽을 믿어야 할지 알 수 없다.
  assert.equal(app.top_titles.reduce((s, t) => s + t.seconds, 0), app.seconds);

  // 반대로 "앱 하나로 묶지 마라" 는 근거는 전체 제목 가짓수다.
  assert.equal(app.distinct_titles, 5, '분류된 것까지 세어야 앱 단위 분류의 위험을 말할 수 있다');
  assert.equal(app.mixed, true);
});

test('하루 마무리 알림 설정과 완료 기록', async () => {
  const s = (await call('GET', '/api/settings')).data;
  assert.equal(s.day_review_hour, '18');
  assert.equal(s.day_review_reminder, '1');
  assert.equal(s.last_day_review, '');

  const today = (await call('GET', '/api/health')).data.today;
  const saved = (await call('PATCH', '/api/settings', {
    day_review_hour: 17, day_review_reminder: false, last_day_review: today,
  })).data;
  assert.equal(saved.day_review_hour, '17');
  assert.equal(saved.day_review_reminder, '0');
  assert.equal(saved.last_day_review, today);

  // 범위 밖 시각과 형식이 틀린 날짜는 거절된다.
  assert.equal((await call('PATCH', '/api/settings', { day_review_hour: 24 })).status, 400);
  assert.equal((await call('PATCH', '/api/settings', { last_day_review: '오늘' })).status, 400);

  // 빈 문자열로 되돌릴 수 있다 — 다시 알림을 받고 싶을 때.
  assert.equal((await call('PATCH', '/api/settings', { last_day_review: '' })).data.last_day_review, '');
  await call('PATCH', '/api/settings', { day_review_hour: 18, day_review_reminder: true });
});

test('설정 키 정의가 서로 어긋나지 않는다', async () => {
  const { SETTING_SPEC, SETTING_DEFAULTS } = await import('../server/api/misc.mjs');

  // 파서에만 있고 기본값이 없으면: 저장은 되지만 조회 결과에서 걸러져 화면에 안 나온다.
  // 기본값에만 있고 파서가 없으면: 값을 바꿀 방법이 없다.
  // 둘 다 조용히 동작하는 것처럼 보이므로 정의를 맞춰 두고 검사한다.
  const spec = Object.keys(SETTING_SPEC).sort();
  const defaults = Object.keys(SETTING_DEFAULTS).sort();
  assert.deepEqual(spec, defaults,
    `파서만: ${spec.filter((k) => !defaults.includes(k))} / 기본값만: ${defaults.filter((k) => !spec.includes(k))}`);

  // 실제로도 모든 키가 조회에 나와야 한다.
  const live = (await call('GET', '/api/settings')).data;
  for (const key of defaults) assert.ok(key in live, `${key} 가 조회 결과에 없습니다`);
});

test('점수 구성 항목은 화면이 아는 다섯 가지로 고정된다', async () => {
  const { cadenceScore } = await import('../server/api/analytics.mjs');
  const score = cadenceScore({
    kinds: { deep: 3600 }, blocks: [], activeSec: 4 * 3600,
    focus: { started: 2, completion_rate: 1 }, switchesPerHour: 8,
  });
  // 화면(today.js)의 PART_LABELS / PART_MAX 가 이 목록을 그대로 안다.
  // 항목을 늘리면 화면에서 이름 없이 나오므로 함께 고쳐야 한다.
  assert.deepEqual(Object.keys(score.parts).sort(),
    ['continuity', 'deep', 'distraction', 'fragmentation', 'sessions']);

  // 만점도 화면과 맞아야 한다.
  //
  // 화면은 `value / PART_MAX[key]` 로 막대 길이를 그린다. 서버에서 배점을 바꾸고 화면을
  // 그대로 두면 막대가 칸을 넘거나 늘 짧게 나오는데, 숫자 자체는 멀쩡해 보여서
  // "왜 40점인데 막대가 꽉 찼지" 같은 의문만 남는다. 이름 목록만 맞춰서는 못 잡는다.
  const fs = await import('node:fs');
  const today = fs.readFileSync(new URL('../web/views/today.js', import.meta.url), 'utf8');
  const m = /const PART_MAX = \{([^}]+)\}/.exec(today);
  assert.ok(m, 'today.js 에서 PART_MAX 를 찾지 못했습니다');
  const partMax = Object.fromEntries(
    m[1].split(',').map((x) => x.split(':').map((y) => y.trim())).filter((x) => x[0])
      .map(([k, v]) => [k, Number(v)]),
  );

  // 각 항목을 만점까지 밀어 올린 하루. 항목별 최대값이 화면이 아는 값과 같아야 한다.
  const best = cadenceScore({
    kinds: { deep: 100 * 3600 },
    blocks: [{ deep_sec: 100 * 3600 }],
    activeSec: 100 * 3600,
    focus: { started: 99, completion_rate: 1 },
    switchesPerHour: 0,
  });
  const wrong = Object.entries(best.parts)
    .filter(([k, v]) => v !== partMax[k])
    .map(([k, v]) => `${k}: 서버 만점 ${v} / 화면 ${partMax[k]}`);
  assert.deepEqual(wrong, [], `배점이 화면과 어긋납니다: ${wrong.join(', ')}`);
  assert.equal(Object.values(partMax).reduce((a, b) => a + b, 0), 100, '배점 합이 100이어야 합니다');
});

test('기간 리포트는 프로젝트 비중이 무엇의 몫인지 밝힌다', async () => {
  // 이 문서는 정산·월간보고에 그대로 붙는다. 위에 "활동 78시간" 이라 적어 놓고 아래 표의
  // 비중이 45/39/17% 면, 읽는 사람은 그것을 활동 전체의 몫으로 읽는다 — 실제로는
  // 프로젝트에 연결된 시간(전체의 30%) 안에서의 몫이다. 그 오해가 비싼 자리다.
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey, shiftDay } = await import('../server/lib/time.mjs');
  const today = dayKey();

  // 프로젝트 절이 반드시 나오도록 심는다 — 없으면 이 검사는 아무것도 지키지 않는다.
  const proj = (await call('POST', '/api/projects', { name: '정산 검사용' })).data;
  const task = (await call('POST', '/api/tasks', { title: '정산 검사 태스크', project_id: proj.id })).data;
  const from = Date.parse(`${today}T09:00:00`);
  db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (?, 'focus', 60, ?, ?, 'done', '', ?)`,
  ).run(task.id, from, from + 3600_000, today);

  const md = (await call('GET', `/api/export/range.md?from=${shiftDay(today, -6)}&to=${today}`)).text;
  assert.ok(md.includes('## 프로젝트별'), '프로젝트 절이 나오지 않았습니다');

  const section = md.split('## 프로젝트별')[1].split('\n## ')[0];
  assert.match(section, /프로젝트에 연결된 시간/, '비중의 기준을 밝히지 않았습니다');
  assert.match(section, /이 시간을 100 으로 놓은 값/);
  assert.match(section, /정산 검사용/);
  assert.doesNotMatch(md, /undefined|NaN/);

  db.prepare('DELETE FROM focus_sessions WHERE task_id = ?').run(task.id);
  await call('DELETE', `/api/tasks/${task.id}`);
  await call('DELETE', `/api/projects/${proj.id}`);
});

test('내보낸 글에는 표본이 모자란 배율을 적지 않는다', async () => {
  // 이 문서는 주간보고에 그대로 붙는다. 한 건짜리 "중앙값 배율 1.75×" 는 근거처럼 읽히면서
  // 근거가 아니다. 화면 세 곳은 표본 수를 확인했는데 마크다운만 빠져 있었다 —
  // 하필 숫자가 가장 무겁게 읽히는 자리였다.
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  db.prepare('DELETE FROM focus_sessions').run();
  db.prepare('DELETE FROM activity').run();

  const base = Date.parse(`${today}T09:00:00`);
  const makeDone = (title, estimateMin, actualMin, offsetH) => {
    const id = Number(db.prepare(
      `INSERT INTO tasks(title, estimate_min, status, completed_at, created_at, updated_at)
       VALUES (?, ?, 'done', ?, ?, ?)`,
    ).run(title, estimateMin, base, base, base).lastInsertRowid);
    const from = base + offsetH * 3600_000;
    db.prepare(
      `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
       VALUES (?, 'focus', ?, ?, ?, 'done', '', ?)`,
    ).run(id, actualMin, from, from + actualMin * 60_000, today);
    return id;
  };

  const ids = [makeDone('한 건짜리', 60, 120, 1)];
  const one = (await call('GET', `/api/export/week.md?day=${today}`)).text;
  assert.match(one, /표본 1개 — 아직 경향이라고 부르기 이릅니다/);
  assert.doesNotMatch(one, /중앙값 배율/, '표본 하나로 중앙값을 말하면 안 됩니다');

  ids.push(makeDone('두 번째', 60, 90, 3), makeDone('세 번째', 60, 100, 5));
  const three = (await call('GET', `/api/export/week.md?day=${today}`)).text;
  assert.match(three, /표본 3개, 중앙값 배율 [\d.]+×/, '세 개부터는 중앙값을 냅니다');

  for (const id of ids) db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  db.prepare('DELETE FROM focus_sessions').run();
});

test('마지막 전체 백업 시각을 기록한다', async () => {
  // 자동 사본은 데이터베이스와 같은 디스크에 있다. 디스크가 죽으면 함께 사라지므로
  // 진짜 백업은 JSON 을 다른 곳에 두는 것뿐인데, 그건 사람이 기억해야 하는 일이다.
  // "한 번도 없음" 과 "그저께" 는 완전히 다른 상태인데 화면에 구별할 방법이 없었다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare("DELETE FROM settings WHERE key = 'last_export_at'").run();

  const before = (await call('GET', '/api/storage')).data;
  assert.equal(before.last_export_at, null, '받아 간 적이 없으면 비어 있어야 한다');

  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/export/all.json`);
  assert.equal(res.status, 200);
  await res.json();

  const after = (await call('GET', '/api/storage')).data;
  assert.ok(after.last_export_at >= t0, `시각이 기록되지 않았습니다: ${after.last_export_at}`);
  assert.ok(after.last_export_at <= Date.now() + 1000);
});

test('카테고리 종류마다 화면에 쓸 이름이 있다', async () => {
  // 종류(kind)는 분석의 축이다. 새로 하나 늘리면 서버는 바로 쓰지만 화면은 모른다 —
  // 설정 화면의 카테고리 목록에 'deep' 같은 영문 키가 그대로 나온다. 죽지는 않지만
  // 만든 사람 말고는 무슨 뜻인지 알 수 없는 화면이 된다.
  const fs = await import('node:fs');
  const { KINDS } = await import('../server/lib/categorize.mjs');
  const src = fs.readFileSync(new URL('../web/views/settings.js', import.meta.url), 'utf8');
  const m = /const KIND_LABELS = \{([\s\S]*?)\}/.exec(src);
  assert.ok(m, 'settings.js 에서 KIND_LABELS 를 찾지 못했습니다');
  const known = [...m[1].matchAll(/(\w+)\s*:/g)].map((x) => x[1]);

  const missing = KINDS.filter((k) => !known.includes(k));
  const extra = known.filter((k) => !KINDS.includes(k));
  assert.deepEqual(missing, [], `화면에 이름이 없는 종류: ${missing.join(', ')}`);
  assert.deepEqual(extra, [], `서버에 없는 종류가 화면에 있습니다: ${extra.join(', ')}`);
});

test('WAL 정리가 최근 기록을 본 파일에 넘긴다', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { db, startWalMaintenance } = await import('../server/lib/db.mjs');
  const { DB_PATH } = await import('../server/lib/config.mjs');

  const walPath = `${DB_PATH}-wal`;
  const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

  // 쓰기를 몰아쳐 WAL 을 키운다.
  for (let i = 0; i < 400; i++) {
    db.prepare(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
       VALUES ('WAL 시험', '', '', ?, ?, 60, 0, '2020-01-01')`,
    ).run(Date.now() + i, Date.now() + i + 60_000);
  }
  const grown = sizeOf(walPath);
  assert.ok(grown > 0, 'WAL 이 만들어져야 이 검사가 의미가 있다');

  // 정리 주기를 짧게 돌려 본다.
  const timer = startWalMaintenance({ intervalMs: 40 });
  await new Promise((r) => setTimeout(r, 200));
  clearInterval(timer);

  assert.ok(sizeOf(walPath) < grown,
    `WAL 이 줄어들지 않았습니다 (${grown} → ${sizeOf(walPath)})`);

  // 데이터는 그대로 있어야 한다 — 정리는 옮기는 것이지 지우는 것이 아니다.
  const n = db.prepare("SELECT COUNT(*) AS n FROM activity WHERE app = 'WAL 시험'").get().n;
  assert.equal(n, 400);
  db.prepare("DELETE FROM activity WHERE app = 'WAL 시험'").run();
  assert.ok(path.isAbsolute(DB_PATH));
});

test('예상치 못한 서버 오류는 기록되고 화면에서 볼 수 있다', async () => {
  const fs = await import('node:fs');
  const { logError, errorLogPath } = await import('../server/lib/errorlog.mjs');

  // 검증 실패(4xx)는 기록하지 않는다 — 사용자가 잘못 누른 것까지 쌓이면 신호가 묻힌다.
  await call('GET', '/api/report/range?from=엉터리');
  await call('POST', '/api/tasks', {});
  assert.equal((await call('GET', '/api/errors')).data.errors.length, 0);

  // 예상 못 한 오류만 남는다.
  logError('GET /api/시험', new Error('시험용 서버 오류'));
  const after = (await call('GET', '/api/errors')).data;
  assert.equal(after.errors.length, 1);
  assert.equal(after.errors[0].context, 'GET /api/시험');
  assert.match(after.errors[0].message, /시험용 서버 오류/);
  assert.ok(after.path.endsWith('cadence-errors.log'));

  // 파일에도 남아야 한다 — 콘솔 없이 돌릴 때 나중에 들여다볼 수 있도록.
  assert.match(fs.readFileSync(errorLogPath(), 'utf8'), /시험용 서버 오류/);

  // 새 것이 앞에 온다.
  logError('두 번째', new Error('나중 오류'));
  assert.equal((await call('GET', '/api/errors')).data.errors[0].context, '두 번째');

  // 지울 수 있다.
  await call('DELETE', '/api/errors');
  assert.equal((await call('GET', '/api/errors')).data.errors.length, 0);
  assert.equal(fs.existsSync(errorLogPath()), false);
});

test('나중에 만든 앱 규칙이 앞선 제목 규칙의 결과를 덮어쓰지 않는다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();
  const base = Date.now() - 4 * 3600_000;

  db.prepare('DELETE FROM activity WHERE day = ?').run(today);

  // 브라우저 한 앱에서 여러 일을 한 상황
  const put = (title, minutes, offset) => db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
     VALUES ('브라우저', ?, '', ?, ?, ?, 0, ?)`,
  ).run(title, base + offset * 60_000, base + (offset + minutes) * 60_000, minutes * 60, today);

  put('사내 코드 리뷰', 30, 0);
  put('점심 뭐 먹지', 20, 40);
  put('배포 절차 문서', 25, 70);

  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');
  const distraction = cats.find((c) => c.name === '방해요소');
  const research = cats.find((c) => c.name === '설계·리서치');

  // 1) 제목 규칙 두 개를 먼저 세운다.
  await call('POST', '/api/rules', {
    field: 'title', pattern: '사내 코드 리뷰', category_id: dev.id, apply_existing: true,
  });
  await call('POST', '/api/rules', {
    field: 'title', pattern: '점심 뭐 먹지', category_id: distraction.id, apply_existing: true,
  });

  // 2) 그 뒤에 앱 전체를 묶는 규칙을 세운다 — 우선순위가 낮다(90 vs 50).
  const appRule = (await call('POST', '/api/rules', {
    field: 'app', pattern: '브라우저', category_id: research.id, apply_existing: true,
  })).data;

  const rows = db.prepare(`
    SELECT a.title, COALESCE(c.name, '미분류') AS cat
    FROM activity a LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.app = '브라우저'
  `).all();
  const by = Object.fromEntries(rows.map((r) => [r.title, r.cat]));

  assert.equal(by['사내 코드 리뷰'], '개발', '제목 규칙이 앱 규칙에 밀리면 안 된다');
  assert.equal(by['점심 뭐 먹지'], '방해요소', '제목 규칙이 앱 규칙에 밀리면 안 된다');
  assert.equal(by['배포 절차 문서'], '설계·리서치', '제목 규칙이 없는 것만 앱 규칙을 따른다');

  // 실제로 바뀐 것만 세어야 한다 — 이미 맞게 분류된 두 건은 건드리지 않는다.
  assert.equal(appRule.updated, 1, `바뀐 건수가 부풀려졌습니다 (${appRule.updated})`);
});

test('자동 사본은 하루에 한 번만 남고 최근 5개만 유지된다', async () => {
  const fs = await import('node:fs');
  const { autoSnapshot } = await import('../server/api/backup.mjs');
  const { DATA_DIR } = await import('../server/lib/config.mjs');

  const count = () => fs.readdirSync(DATA_DIR).filter((f) => /^cadence-backup-.*\.db$/.test(f)).length;

  // 앞선 검사들이 가져오기·정리를 하며 사본을 남겼을 수 있다. 나이 제한을 0 으로 두어
  // "오래됐으면 만든다" 쪽을 강제로 확인한다.
  assert.equal(autoSnapshot({ maxAgeMs: 0 }).created, true, '오래된 사본만 있으면 새로 만든다');
  const after = count();

  // 방금 만들었으므로 하루 기준으로는 다시 만들지 않는다.
  assert.equal(autoSnapshot().created, false, '사본이 최근이면 건너뛴다');
  assert.equal(count(), after);

  // 몇 번을 더 돌려도 5개를 넘기지 않는다.
  for (let i = 0; i < 7; i++) {
    autoSnapshot({ maxAgeMs: 0 });
    // 파일 이름이 밀리초 단위라 같은 순간에 겹치지 않도록 잠깐 벌린다.
    await new Promise((r) => setTimeout(r, 4));
  }
  assert.ok(count() <= 5, `사본이 ${count()}개까지 쌓였습니다`);

  // 시계가 뒤로 가도 자동 사본이 멈추지 않는다.
  //
  // 서머타임·NTP 보정·시각이 틀린 채 쓰던 노트북 — 사본 파일이 '미래' 시각을 달게 되는
  // 경로는 흔하다. 나이를 그냥 빼서 비교하면 음수는 언제나 "최근" 이라, 그때부터
  // 사본이 영영 만들어지지 않는다. 오류도 없고 화면에도 안 뜬다.
  const newest = fs.readdirSync(DATA_DIR)
    .filter((f) => /^cadence-backup-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(`${DATA_DIR}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  const future = Date.now() + 10 * 86_400_000;
  fs.utimesSync(`${DATA_DIR}/${newest.f}`, future / 1000, future / 1000);

  assert.equal(autoSnapshot().created, true,
    '사본이 미래 시각을 달고 있으면 새로 만들어야 합니다 — 아니면 백업이 영영 멈춥니다');

  // 다만 **아주 조금** 앞선 것은 시계가 뒤로 간 것이 아니다.
  //
  // 파일 시각은 밀리초 아래 자릿수까지 남는데 `Date.now()` 는 잘라 버린다. 그래서
  // 방금 만든 사본이 0.3ms 쯤 미래로 보이는 일이 흔하다 — 파일 시각이 촘촘한 리눅스에서
  // 특히 그렇다. 그걸 "시계가 뒤로 갔다" 로 읽으면 방금 만든 사본 옆에 하나를 더 만든다.
  // CI 의 리눅스 판에서 **가끔만** 실패하는 검사로 드러났다. 여기서만 돌려서는 못 만난다.
  const fresh = fs.readdirSync(DATA_DIR)
    .filter((f) => /^cadence-backup-.*\.db$/.test(f))
    .map((f) => ({ f, t: fs.statSync(`${DATA_DIR}/${f}`).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0];
  const slightlyAhead = (Date.now() + 2) / 1000;
  fs.utimesSync(`${DATA_DIR}/${fresh.f}`, slightlyAhead, slightlyAhead);
  assert.equal(autoSnapshot().created, false,
    '방금 만든 사본이 몇 밀리초 앞서 보인다고 사본을 또 만들면 안 됩니다');

  // 사용자가 손으로 넣어 둔 파일은 우리 것이 아니다.
  //
  // 이름을 `cadence-backup-*.db` 로 헐겁게 잡으면, 같은 폴더에 손으로 저장해 둔
  // `cadence-backup-중요.db` 도 정리 대상(최근 5개만 유지)이 되어 조용히 지워진다.
  // 남의 파일을 지우는 것은 되돌릴 수 없어 한 번의 실수로 끝난다.
  const mine = `${DATA_DIR}/cadence-backup-내가-따로-받아둔-것.db`;
  fs.writeFileSync(mine, 'not a database');
  // 오래된 파일로 만들어 둔다. 방금 만든 파일은 최근 5개 안에 들어 살아남으므로,
  // 그대로 두면 이름 규칙이 헐거워져도 이 검사가 알아채지 못한다.
  const old = Date.now() - 30 * 86_400_000;
  fs.utimesSync(mine, old / 1000, old / 1000);
  for (let i = 0; i < 8; i++) {
    autoSnapshot({ maxAgeMs: 0 });
    await new Promise((r) => setTimeout(r, 4));
  }
  assert.ok(fs.existsSync(mine), '사용자가 넣어 둔 파일을 지웠습니다');
  fs.unlinkSync(mine);
});

test('짧은 조각으로만 쌓인 앱도 분류 목록에 오른다', async () => {
  // 실제 추적 기록은 폴링 주기(기본 4초)마다, 그리고 창 제목이 바뀔 때마다 끊긴다.
  // 그래서 하루 종일 쓴 브라우저도 개별 행은 몇 초짜리다.
  // 앞선 검사는 40분짜리 한 줄로 확인하고 있어서, 합계가 아니라 한 조각의 길이를
  // 기준으로 거르는 실수를 잡지 못했다 — 그 상태에서 이 목록은 늘 비어 있었다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T09:00:00`);
  const insert = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, ?, 'chrome', ?, ?, 4, 0, NULL, ?)`,
  );
  // 4초짜리 300조각 = 20분. 조각 하나만 보면 기준(5분)에 한참 못 미친다.
  for (let i = 0; i < 300; i++) {
    const s = base + i * 4000;
    insert.run('Google Chrome', `문서 ${i % 7}`, s, s + 4000, today);
  }

  const data = (await call('GET', '/api/activity/unclassified?days=1')).data;
  assert.deepEqual(data.apps.map((a) => a.app), ['Google Chrome']);
  assert.equal(data.apps[0].seconds, 1200, '조각들의 합계로 판단해야 한다');
  assert.equal(data.apps[0].mixed, true, '창 제목이 여러 갈래면 제목별로 나누도록 유도한다');
  assert.equal(data.unclassified_sec, 1200);
});

test('가져오기가 중간에 실패하면 아무것도 바뀌지 않는다', async () => {
  // 복원은 기존 데이터를 지우고 시작한다. 중간에 엎어졌을 때 절반만 남으면
  // 사용자는 백업도 원본도 없는 상태가 된다 — 가장 잃으면 안 되는 순간이다.
  const before = (await call('GET', '/api/export/all.json')).data;
  const beforeCounts = {
    activity: before.activity.length,
    tasks: before.tasks.length,
    notes: before.notes.length,
  };
  assert.ok(beforeCounts.activity > 0, '검사 전제: 지울 데이터가 있어야 한다');

  // 마지막 활동 행만 없는 카테고리를 가리키게 한다 → 외래키 위반으로 끝에서 실패.
  const broken = structuredClone(before);
  broken.activity[broken.activity.length - 1].category_id = 999_999;
  broken.notes = [];
  broken.tasks = [];

  const res = await call('POST', '/api/import', { data: broken, mode: 'replace' });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /데이터가 바뀌지 않았습니다/);
  // 되돌릴 사본이 어디 있는지도 알려 준다.
  assert.match(String(res.data.detail), /cadence-backup-/);

  const after = (await call('GET', '/api/export/all.json')).data;
  assert.deepEqual(
    { activity: after.activity.length, tasks: after.tasks.length, notes: after.notes.length },
    beforeCounts,
    '실패한 가져오기가 기존 데이터를 건드렸습니다',
  );
  assert.equal((await call('GET', '/api/storage/integrity')).data.ok, true);
});

test('업무일 시작 시각을 바꾸면 지난 기록의 날짜도 다시 매긴다', async () => {
  // day 는 기록될 때 확정된다. 경계를 바꾸고 과거를 그대로 두면 한 화면 안에서
  // '하루'의 뜻이 두 개가 된다 — 숫자는 멀쩡해 보여서 아무도 눈치채지 못한다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();

  await call('PATCH', '/api/settings', { day_start_hour: 4 });

  // 새벽 5시 — 시작 시각이 4시면 그날, 6시면 전날에 속한다.
  const at5am = Date.parse('2026-05-20T05:00:00');
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Code', 'a.js', '', ?, ?, 600, 0, NULL, ?)`,
  ).run(at5am, at5am + 600_000, '2026-05-20');
  db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (NULL, 'focus', 25, ?, ?, 'completed', '', ?)`,
  ).run(at5am, at5am + 1500_000, '2026-05-20');

  const dayOf = (table) => db.prepare(`SELECT day FROM ${table} LIMIT 1`).get().day;
  assert.equal(dayOf('activity'), '2026-05-20');

  await call('PATCH', '/api/settings', { day_start_hour: 6 });
  assert.equal(dayOf('activity'), '2026-05-19', '05시 기록은 06시 기준으로는 전날이다');
  assert.equal(dayOf('focus_sessions'), '2026-05-19', '세션도 함께 옮겨야 한다');

  // 되돌리면 원래대로.
  await call('PATCH', '/api/settings', { day_start_hour: 4 });
  assert.equal(dayOf('activity'), '2026-05-20');
  assert.equal(dayOf('focus_sessions'), '2026-05-20');

  // 다른 설정만 바꿀 때는 건드리지 않는다.
  db.prepare("UPDATE activity SET day = '표시'").run();
  await call('PATCH', '/api/settings', { default_focus_min: 30 });
  assert.equal(dayOf('activity'), '표시', '관계없는 설정 변경에 날짜를 다시 매기면 안 된다');

  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();
});

test('규칙을 고치거나 지우면 과거 기록도 함께 다시 분류된다', async () => {
  // 타임라인에서 규칙을 만들 때는 과거까지 정리해 주면서 설정에서 고칠 때는 그러지 않으면,
  // 규칙 목록과 실제 분류가 조용히 어긋난다. 사용자는 그 사실을 알 방법이 없다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare("DELETE FROM rules WHERE pattern LIKE '검사%'").run();

  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');
  const comms = cats.find((c) => c.name === '커뮤니케이션');
  const unclassified = cats.find((c) => c.kind === 'other');

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T10:00:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('검사도구', '무언가', '', ?, ?, 600, 0, NULL, ?)`,
  ).run(base, base + 600_000, today);

  const catOf = () => db.prepare("SELECT category_id FROM activity WHERE app = '검사도구'").get().category_id;

  const rule = (await call('POST', '/api/rules', {
    field: 'app', pattern: '검사도구', category_id: dev.id, apply_existing: true,
  })).data;
  assert.equal(catOf(), dev.id);

  const ruleId = db.prepare("SELECT id FROM rules WHERE pattern = '검사도구'").get().id;

  // 카테고리를 바꾸면 과거 기록도 따라온다.
  const patched = (await call('PATCH', `/api/rules/${ruleId}`, { category_id: comms.id })).data;
  assert.equal(catOf(), comms.id, '규칙을 고쳤는데 과거 기록이 그대로입니다');
  assert.equal(patched.updated, 1, '몇 건이 바뀌었는지 알려 줘야 한다');

  // 아무것도 달라지지 않는 수정은 0건으로 보고한다.
  assert.equal((await call('PATCH', `/api/rules/${ruleId}`, { priority: 77 })).data.updated, 0);

  // 규칙을 지우면 미분류로 돌아간다.
  const deleted = (await call('DELETE', `/api/rules/${ruleId}`)).data;
  assert.equal(deleted.updated, 1);
  assert.equal(catOf(), unclassified.id, '규칙을 지웠는데 옛 분류가 남았습니다');

  assert.ok(rule.created);
  db.prepare('DELETE FROM activity').run();
});

test('합치기 가져오기는 실제로 들어간 건수만 보고한다', async () => {
  // INSERT OR IGNORE 는 같은 id 가 있으면 조용히 넘어간다. 시도 횟수를 세면
  // 한 건도 안 들어간 가져오기가 "전부 복원 완료"로 보고된다 — 가장 위험한 거짓말이다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T13:00:00`);
  const insert = db.prepare(
    `INSERT INTO activity(id, app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, ?, '', '', ?, ?, 300, 0, NULL, ?)`,
  );
  insert.run(9001, '앱A', base, base + 300_000, today);
  insert.run(9002, '앱B', base + 300_000, base + 600_000, today);

  const backup = (await call('GET', '/api/export/all.json')).data;
  // 백업에 없던 행 하나를 더 넣는다.
  backup.activity.push({
    ...backup.activity[0], id: 9003, app: '앱C',
    started_at: base + 600_000, ended_at: base + 900_000,
  });

  const merged = (await call('POST', '/api/import', { data: backup, mode: 'merge' })).data;
  assert.equal(merged.counts.activity, 1, '새 행 하나만 들어가야 한다');
  assert.ok(merged.skipped >= 2, `이미 있던 행은 건너뛴 것으로 세야 한다 (skipped=${merged.skipped})`);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 3);

  // 덮어쓰기는 전부 새로 들어가므로 건너뛴 것이 없다.
  const replaced = (await call('POST', '/api/import', { data: backup, mode: 'replace' })).data;
  assert.equal(replaced.counts.activity, 3);
  assert.equal(replaced.skipped, 0);

  db.prepare('DELETE FROM activity').run();
});

test('시간 구간을 통째로 태스크에 지정한다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const t = (h, mi = 0) => Date.parse(`${today}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');

  const task = (await call('POST', '/api/tasks', { title: '구간 지정 검사' })).data;

  const ins = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
     VALUES (?, '', '', ?, ?, ?, ?, NULL, NULL, ?)`,
  );
  // 자동 추적이 만드는 모양: 짧은 조각 여러 개.
  ins.run('Code', t(10), t(10, 20), 1200, 0, today);      // 구간 안
  ins.run('Chrome', t(10, 20), t(10, 50), 1800, 0, today); // 구간 안
  ins.run('Slack', t(10, 50), t(11, 10), 1200, 0, today);  // 경계에 걸침
  ins.run('Word', t(13), t(13, 30), 1800, 0, today);       // 구간 밖
  ins.run('(자리비움)', t(10, 30), t(10, 40), 600, 1, today); // 자리비움

  const from = t(10);
  const to = t(11);

  const preview = (await call('GET', `/api/activity/range?from=${from}&to=${to}`)).data;
  assert.equal(preview.count, 3, '경계에 걸친 기록도 포함하고 자리비움은 뺀다');
  assert.equal(preview.seconds, 1200 + 1800 + 1200);
  assert.deepEqual(preview.apps.map((a) => a.app), ['Chrome', 'Code', 'Slack']);

  const res = (await call('POST', '/api/activity/range', {
    from, to, task_id: task.id, category_id: dev.id,
  })).data;
  assert.equal(res.updated, 3);

  const rows = db.prepare('SELECT app, task_id, category_id, idle FROM activity ORDER BY started_at').all();
  const assigned = rows.filter((r) => r.task_id === task.id);
  assert.deepEqual(assigned.map((r) => r.app).sort(), ['Chrome', 'Code', 'Slack']);
  assert.ok(rows.every((r) => r.idle === 0 || r.task_id === null), '자리비움은 건드리지 않는다');
  assert.equal(rows.find((r) => r.app === 'Word').task_id, null, '구간 밖은 그대로다');

  // 검증
  assert.equal((await call('POST', '/api/activity/range', { from: to, to: from, task_id: task.id })).status, 400);
  assert.equal((await call('POST', '/api/activity/range', { from, to })).status, 400, '무엇을 지정할지 없으면 거절');
  assert.equal((await call('POST', '/api/activity/range', {
    from, to: from + 25 * 3600_000, task_id: task.id,
  })).status, 400, '24시간을 넘으면 거절');
  assert.equal((await call('POST', '/api/activity/range', { from, to, task_id: 999999 })).status, 400);

  // 연결을 풀 수도 있어야 한다.
  const cleared = (await call('POST', '/api/activity/range', { from, to, task_id: null })).data;
  assert.equal(cleared.updated, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity WHERE task_id IS NOT NULL').get().n, 0);

  await call('DELETE', `/api/tasks/${task.id}`);
  db.prepare('DELETE FROM activity').run();
});

test('CSV 내보내기는 엑셀 수식 주입을 막는다', async () => {
  // 창 제목은 다른 프로그램이 정한다. 그것이 그대로 CSV 에 들어가고, 사용자는
  // 그 파일을 엑셀로 연다 — '=' 로 시작하는 칸을 엑셀은 수식으로 읽는다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T09:00:00`);
  const ins = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, ?, '', ?, ?, 60, 0, NULL, ?)`,
  );
  ins.run('보통 앱', '평범한 제목', base, base + 60_000, today);
  ins.run('=cmd|\'/c calc\'!A1', "@SUM(1+1)*cmd|'/c calc'!A1", base + 60_000, base + 120_000, today);
  ins.run('쉼표, 따옴표"와 줄바꿈\n포함', '-1+1', base + 120_000, base + 180_000, today);

  // fetch 의 text() 는 BOM 을 떼어 버리므로, BOM 확인은 바이트로 해야 한다.
  const raw = new Uint8Array(
    await (await fetch(`${BASE}/api/export/activity.csv?from=${today}&to=${today}`)).arrayBuffer(),
  );
  assert.deepEqual([...raw.slice(0, 3)], [0xef, 0xbb, 0xbf],
    'UTF-8 BOM 이 없습니다 — 엑셀이 한글을 깨뜨립니다');

  const csv = new TextDecoder().decode(raw);

  const lines = csv.split('\n');
  assert.ok(lines.some((l) => l.includes("'=cmd")), '= 로 시작하는 칸이 그대로 나갔습니다');
  assert.ok(lines.some((l) => l.includes("'@SUM")), '@ 로 시작하는 칸이 그대로 나갔습니다');
  assert.ok(lines.some((l) => l.includes("'-1+1")), '- 로 시작하는 칸이 그대로 나갔습니다');

  // 수식이 될 수 없는 값은 건드리지 않는다.
  assert.ok(csv.includes('평범한 제목'));
  assert.ok(!csv.includes("'평범한"));

  // 쉼표·따옴표·줄바꿈은 여전히 제대로 감싼다.
  assert.ok(csv.includes('"쉼표, 따옴표""와 줄바꿈\n포함"'), '따옴표 감싸기가 깨졌습니다');

  db.prepare('DELETE FROM activity').run();
});

test('기록이 얕은 날은 마크다운에도 0점이라고 적지 않는다', async () => {
  // 이 문서는 일지·주간보고에 그대로 붙는다. "0점" 이라고 적혀 있으면
  // 추적을 안 켠 날이 형편없었던 날로 남는다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const md = (await call('GET', `/api/export/day.md?day=${today}`)).text;

  assert.match(md, /기록 부족/);
  assert.doesNotMatch(md, /점수 0\/100/);
  // 내용이 없는 절은 제목만 남기지 않는다.
  assert.doesNotMatch(md, /## 시간 배분\n\n/);

  // 기록이 충분하면 평소대로 점수를 적는다.
  const base = Date.parse(`${today}T09:00:00`);
  const cat = db.prepare("SELECT id FROM categories WHERE kind = 'deep'").get().id;
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Code', 'a.js', '', ?, ?, 3600, 0, ?, ?)`,
  ).run(base, base + 3600_000, cat, today);

  const md2 = (await call('GET', `/api/export/day.md?day=${today}`)).text;
  assert.match(md2, /Cadence 점수 \d+\/100/);
  assert.match(md2, /## 시간 배분/);

  db.prepare('DELETE FROM activity').run();
});

test('창 제목에서 되풀이되는 낱말을 규칙 후보로 뽑는다', async () => {
  // 브라우저 제목은 "<페이지> - <사이트> - Chrome" 이고 페이지 이름은 매번 다르다.
  // 제목을 하나씩 눌러 분류하면 오늘 것만 정리되고 내일 또 새 제목이 생긴다 —
  // 미분류가 줄지 않는 진짜 이유가 이것이다. 되풀이되는 조각을 찾아야 규칙이 계속 일한다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  let cursor = Date.parse(`${today}T09:00:00`);
  const add = (title, minutes) => {
    const end = cursor + minutes * 60_000;
    db.prepare(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES ('Google Chrome', ?, 'chrome', ?, ?, ?, 0, NULL, ?)`,
    ).run(title, cursor, end, minutes * 60, today);
    cursor = end;
  };

  add('cadence · 이슈 #12 - GitHub - Chrome', 20);
  add('cadence · 풀 리퀘스트 - GitHub - Chrome', 15);
  add('some-org/another-repo - GitHub - Chrome', 10);
  add('사용자 목록 - 관리 콘솔 - Chrome', 12);
  add('그룹 설정 - 관리 콘솔 - Chrome', 8);
  add('아무도 안 보는 페이지 - Chrome', 30); // 한 번뿐이라 후보가 되면 안 된다

  const res = (await call('GET', '/api/activity/title-suggestions?app=Google%20Chrome')).data;
  const tokens = res.suggestions.map((s) => s.token);

  assert.ok(tokens.includes('GitHub'), `GitHub 이 후보에 없습니다: ${tokens.join(', ')}`);
  assert.ok(tokens.includes('관리 콘솔'), `'관리 콘솔' 이 후보에 없습니다: ${tokens.join(', ')}`);

  // 앱 이름은 모든 제목에 있지만 후보가 아니다 — 그건 앱 단위 규칙이다.
  assert.ok(!tokens.some((t) => /chrome/i.test(t)), `앱 이름이 후보에 올랐습니다: ${tokens.join(', ')}`);
  // 한 제목에만 나오는 낱말은 규칙으로 만들 이유가 없다.
  assert.ok(!tokens.includes('아무도 안 보는 페이지'));

  const github = res.suggestions.find((s) => s.token === 'GitHub');
  assert.equal(github.seconds, (20 + 15 + 10) * 60);
  assert.equal(github.titles, 3);
  assert.equal(res.examined_titles, 6);
  assert.equal(res.truncated, false);

  // 시간이 큰 것이 위로 온다 — 위에서 몇 개만 눌러도 대부분이 정리되도록.
  assert.equal(tokens[0], 'GitHub');

  // 하위 낱말은 접는다: '관리', '콘솔' 이 '관리 콘솔' 과 같은 것을 잡는다면 긴 쪽만 남는다.
  assert.ok(!tokens.includes('관리'), `하위 낱말이 함께 올라왔습니다: ${tokens.join(', ')}`);

  // 이미 분류된 기록은 세지 않는다.
  const dev = (await call('GET', '/api/categories')).data.find((c) => c.name === '개발');
  await call('POST', '/api/rules', {
    field: 'title', pattern: 'GitHub', category_id: dev.id, apply_existing: true,
  });
  const after = (await call('GET', '/api/activity/title-suggestions?app=Google%20Chrome')).data;
  assert.ok(!after.suggestions.some((s) => s.token === 'GitHub'), '분류된 뒤에도 후보로 남았습니다');

  db.prepare("DELETE FROM rules WHERE pattern = 'GitHub' AND is_regex = 0 AND priority = 50").run();
  db.prepare('DELETE FROM activity').run();
});

test('같은 규칙을 다시 가르치면 행이 쌓이지 않는다', async () => {
  // "이 앱을 항상 이렇게" 는 몇 번이고 눌리는 버튼이다. 누를 때마다 행이 하나씩 쌓이면
  // 우선순위가 다른 사본끼리 서로를 가려, 어느 것이 적용되는지 화면으로는 알 수 없게 된다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare("DELETE FROM rules WHERE pattern = '되풀이검사'").run();
  db.prepare('DELETE FROM activity').run();

  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');
  const comms = cats.find((c) => c.name === '커뮤니케이션');

  const first = (await call('POST', '/api/rules', {
    field: 'title', pattern: '되풀이검사', category_id: dev.id, apply_existing: false,
  })).data;
  assert.equal(first.created, true);

  const again = (await call('POST', '/api/rules', {
    field: 'title', pattern: '되풀이검사', category_id: comms.id, apply_existing: false,
  })).data;
  assert.equal(again.created, false, '같은 규칙이 또 만들어졌습니다');
  assert.equal(again.replaced, true);

  const rows = db.prepare("SELECT * FROM rules WHERE pattern = '되풀이검사'").all();
  assert.equal(rows.length, 1, `규칙이 ${rows.length}개 쌓였습니다`);
  assert.equal(rows[0].category_id, comms.id, '나중에 가르친 분류가 이겨야 한다');

  // 대상(앱/제목)이 다르면 별개 규칙이다.
  await call('POST', '/api/rules', {
    field: 'app', pattern: '되풀이검사', category_id: dev.id, apply_existing: false,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM rules WHERE pattern = '되풀이검사'").get().n, 2);

  db.prepare("DELETE FROM rules WHERE pattern = '되풀이검사'").run();
});

test('켜 놓고 잊은 세션은 새 세션을 시작할 때 완주로 남지 않는다', async () => {
  // 사흘 전에 켜 둔 세션이 "3일짜리 완주"로 남으면 완주율도 태스크 투입 시간도 망가진다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM focus_sessions').run();

  const threeDaysAgo = Date.now() - 3 * 86_400_000;
  db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (NULL, 'focus', 25, ?, NULL, 'running', '', '2026-01-01')`,
  ).run(threeDaysAgo);

  await call('POST', '/api/sessions', { planned_min: 25, kind: 'focus' });

  const stale = db.prepare('SELECT * FROM focus_sessions WHERE started_at = ?').get(threeDaysAgo);
  assert.equal(stale.status, 'abandoned', '잊은 세션이 완주로 남았습니다');
  assert.equal(stale.ended_at - stale.started_at, 25 * 60_000, '계획한 만큼으로 줄여야 합니다');

  // 반대로, 사용자가 직접 끝낸 긴 세션은 그대로 인정한다 — 실제로 오래 몰입했을 수 있다.
  const running = (await call('GET', '/api/sessions/running')).data;
  const longAgo = Date.now() - 5 * 3600_000;
  db.prepare('UPDATE focus_sessions SET started_at = ? WHERE id = ?').run(longAgo, running.id);
  const ended = (await call('POST', `/api/sessions/${running.id}/end`, { status: 'done' })).data;
  assert.equal(ended.status, 'done', '직접 끝낸 세션을 마음대로 중단으로 바꾸면 안 됩니다');
  assert.ok(ended.elapsed_sec > 4 * 3600, '길이도 그대로 두어야 합니다');

  db.prepare('DELETE FROM focus_sessions').run();
});

test('같은 구간을 두 번 기록하지 않는다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM focus_sessions').run();

  const start = Date.now() - 3600_000;
  const end = start + 1800_000;
  const first = (await call('POST', '/api/sessions/record', { start, end })).data;
  const again = (await call('POST', '/api/sessions/record', { start: start + 60_000, end: end + 60_000 })).data;

  assert.equal(again.id, first.id, '겹치는 구간이 새 세션으로 또 들어갔습니다');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM focus_sessions').get().n, 1);

  // 겹치지 않는 구간은 정상적으로 들어간다.
  const later = (await call('POST', '/api/sessions/record', { start: end + 60_000, end: end + 120_000 })).data;
  assert.notEqual(later.id, first.id);

  // 말이 안 되는 길이는 거절한다.
  assert.equal((await call('POST', '/api/sessions/record', {
    start, end: start + 30 * 3600_000,
  })).status, 400);

  db.prepare('DELETE FROM focus_sessions').run();
});

test('수동 입력은 겹치는 기록을 대신한다 — 같은 시각을 두 번 세지 않도록', async () => {
  // 자리비움 30분 위에 회의 30분을 그냥 얹으면 하루가 한 시간 늘어난다.
  // 화면 어디에도 "겹쳤습니다" 라고 나오지 않아 아무도 눈치채지 못한다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const t = (h, mi = 0) => Date.parse(`${today}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
  const ins = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, '', '', ?, ?, ?, ?, NULL, ?)`,
  );
  ins.run('(자리비움)', t(10), t(10, 30), 1800, 1, today);   // 완전히 안에 들어감 → 삭제
  ins.run('Slack', t(10, 20), t(10, 50), 1800, 0, today);    // 앞이 겹침 → 잘림
  ins.run('Code', t(9, 30), t(10, 5), 2100, 0, today);       // 뒤가 겹침 → 잘림
  ins.run('Word', t(13), t(15), 7200, 0, today);             // 구간을 감쌈 → 앞뒤로 쪼갬

  const before = (await call('GET', `/api/activity/manual/preview?started_at=${t(10)}&minutes=30`)).data;
  assert.equal(before.count, 3, '겹치는 기록을 미리 알려 준다');

  const added = (await call('POST', '/api/activity/manual', {
    started_at: t(10), minutes: 30, app: '회의', title: '주간 스프린트',
  })).data;
  assert.equal(added.cleared.removed, 1, '완전히 들어간 기록은 지운다');
  assert.equal(added.cleared.trimmed, 2, '걸친 기록은 자른다');

  const rows = db.prepare('SELECT app, started_at, ended_at, seconds, idle FROM activity ORDER BY started_at').all();
  const byApp = Object.fromEntries(rows.map((r) => [r.app, r]));
  assert.equal(byApp['(자리비움)'], undefined, '자리비움이 남았습니다');
  assert.equal(byApp.Code.ended_at, t(10), 'Code 가 구간 시작에서 끊겨야 합니다');
  assert.equal(byApp.Code.seconds, 30 * 60);
  assert.equal(byApp.Slack.started_at, t(10, 30), 'Slack 이 구간 끝부터 시작해야 합니다');
  assert.equal(byApp.Slack.seconds, 20 * 60);
  assert.equal(byApp['회의'].seconds, 30 * 60);

  // 어떤 두 기록도 겹치지 않는다.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].started_at >= rows[i - 1].ended_at,
      `${rows[i - 1].app} 와 ${rows[i].app} 가 겹칩니다`);
  }

  // 감싸는 기록은 앞뒤 두 조각으로 남는다.
  db.prepare('DELETE FROM activity').run();
  ins.run('Word', t(13), t(15), 7200, 0, today);
  await call('POST', '/api/activity/manual', { started_at: t(14), minutes: 20, app: '통화', title: '' });
  const wordPieces = db.prepare("SELECT * FROM activity WHERE app = 'Word' ORDER BY started_at").all();
  assert.equal(wordPieces.length, 2, '감싸는 기록이 앞뒤로 쪼개져야 합니다');
  assert.equal(wordPieces[0].ended_at, t(14));
  assert.equal(wordPieces[1].started_at, t(14, 20));

  // 끄고 싶으면 끌 수 있다.
  db.prepare('DELETE FROM activity').run();
  ins.run('Slack', t(10), t(11), 3600, 0, today);
  const kept = (await call('POST', '/api/activity/manual', {
    started_at: t(10), minutes: 30, app: '회의', title: '', replace_overlap: false,
  })).data;
  assert.equal(kept.cleared.removed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 2);

  db.prepare('DELETE FROM activity').run();
});

test('겹치는 기록을 찾아내고 고친다', async () => {
  // 집계는 seconds 를 그냥 더한다. 겹친 만큼 하루가 길어지는데 숫자는 멀쩡해 보인다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();

  const today = (await call('GET', '/api/health')).data.today;
  const t = (h, mi = 0) => Date.parse(`${today}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
  const ins = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, '', '', ?, ?, ?, 0, NULL, ?)`,
  );
  ins.run('Code', t(9), t(10), 3600, today);
  ins.run('Chrome', t(9, 40), t(10, 30), 3000, today);  // 20분 겹침
  ins.run('Slack', t(11), t(11, 30), 1800, today);       // 겹치지 않음

  const before = (await call('GET', '/api/storage/integrity')).data;
  const overlap = before.issues.find((i) => i.key === 'overlap');
  assert.ok(overlap, `겹침을 못 찾았습니다: ${before.issues.map((i) => i.key).join(', ')}`);
  assert.equal(overlap.count, 1);

  // 고치기 전에는 합계가 부풀어 있다: 60 + 50 + 30 = 140분 (실제로 흐른 시간은 120분)
  const sumBefore = db.prepare('SELECT SUM(seconds) AS s FROM activity').get().s;
  assert.equal(sumBefore, (60 + 50 + 30) * 60);

  const repaired = (await call('POST', '/api/storage/repair')).data;
  assert.equal(repaired.repaired.overlap, 1);
  assert.equal(repaired.ok, true, `고친 뒤에도 문제가 남았습니다: ${JSON.stringify(repaired.issues)}`);

  // 둘 다 자동 기록이면 앞선 쪽(Code)이 그대로 남고 뒤엣것(Chrome)이 겹친 만큼만 밀린다.
  const rows = db.prepare('SELECT app, started_at, ended_at, seconds FROM activity ORDER BY started_at').all();
  const byApp = Object.fromEntries(rows.map((r) => [r.app, r]));
  assert.equal(byApp.Code.ended_at, t(10), '앞선 기록은 그대로 남아야 합니다');
  assert.equal(byApp.Chrome.started_at, t(10), '짧은 기록이 겹치지 않는 자리로 밀려야 합니다');
  assert.equal(byApp.Chrome.seconds, 30 * 60);

  // 무엇보다 중요한 것: 겹침이 사라지고 하루가 부풀지 않는다.
  assert.equal(db.prepare('SELECT SUM(seconds) AS s FROM activity').get().s, (60 + 30 + 30) * 60);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].started_at >= rows[i - 1].ended_at, '고친 뒤에도 겹칩니다');
  }

  db.prepare('DELETE FROM activity').run();
});

test('손으로 넣은 기록이 겹침 판정에서 이긴다', async () => {
  // "이 시간에는 회의였다" 는 사용자의 단언이고, 그 시간대의 자동 기록은
  // 창을 열어 둔 채 자리를 비운 흔적일 뿐이다 — 길이와 상관없이 손으로 넣은 쪽이 맞다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const t = (h, mi = 0) => Date.parse(`${today}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, '', ?, ?, ?, ?, 0, NULL, ?)`,
  ).run('Code', '', t(14), t(16), 7200, today);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, '', 'manual', ?, ?, ?, 0, NULL, ?)`,
  ).run('회의', t(15), t(15, 30), 1800, today);

  await call('POST', '/api/storage/repair');

  const rows = db.prepare('SELECT app, exe, started_at, ended_at FROM activity ORDER BY started_at').all();
  const meeting = rows.find((r) => r.exe === 'manual');
  assert.ok(meeting, '손으로 넣은 기록이 사라졌습니다');
  assert.equal(meeting.started_at, t(15), '손으로 넣은 기록은 그대로여야 합니다');
  assert.equal(meeting.ended_at, t(15, 30));
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].started_at >= rows[i - 1].ended_at, '고친 뒤에도 겹칩니다');
  }

  db.prepare('DELETE FROM activity').run();
});

test('겹침이 사슬처럼 이어져 있어도 한 번에 끝난다', async () => {
  // 처음 만든 복구는 "겹친 두 줄 중 진 쪽을 옮긴다" 를 되풀이했는데, 한 줄을 옮기면
  // 옆줄과 새로 겹치는 일이 생겨 9만 번을 고치고도 끝나지 않았다.
  // 시각 순으로 한 번만 훑으면 앞으로만 나아가므로 반드시 끝난다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T08:00:00`);
  const ins = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, '', '', ?, ?, ?, 0, NULL, ?)`,
  );
  // 200개가 10분짜리인데 5분씩만 밀려 있다 — 모두가 이웃과 겹친다.
  for (let i = 0; i < 200; i++) {
    const s = base + i * 5 * 60_000;
    ins.run(`앱${i}`, s, s + 10 * 60_000, 600, today);
  }
  const sumBefore = db.prepare('SELECT SUM(seconds) AS s FROM activity').get().s;
  assert.equal(sumBefore, 200 * 600, '고치기 전에는 실제로 흐른 시간의 두 배 가까이 된다');

  const res = (await call('POST', '/api/storage/repair')).data;
  assert.equal(res.ok, true, `한 번에 끝나야 합니다: ${JSON.stringify(res.issues)}`);

  const rows = db.prepare('SELECT started_at, ended_at, seconds FROM activity ORDER BY started_at').all();
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].started_at >= rows[i - 1].ended_at, `${i}번째에서 아직 겹칩니다`);
  }
  // 겹친 부분만 덜어 냈으므로, 남은 합계는 실제로 흐른 시간과 같다.
  const span = Math.round((rows[rows.length - 1].ended_at - rows[0].started_at) / 1000);
  assert.equal(db.prepare('SELECT SUM(seconds) AS s FROM activity').get().s, span);

  db.prepare('DELETE FROM activity').run();
});

test('겹치는 집중 세션을 찾아내고 고친다', async () => {
  // 이 앱은 세션을 한 번에 하나만 연다. 겹친 세션은 밖에서 들어온 것이고,
  // 그대로 두면 태스크 투입 시간이 두 번 세어진다 — 화면에는 "많이 했다" 로만 보인다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM focus_sessions').run();
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const t = (h, mi = 0) => Date.parse(`${today}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00`);
  const ins = db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (NULL, 'focus', 25, ?, ?, 'done', '', ?)`,
  );
  ins.run(t(9), t(10), today);
  ins.run(t(9, 30), t(10, 30), today);  // 걸침 → 뒤로 밀린다
  ins.run(t(9, 45), t(9, 50), today);   // 완전히 덮임 → 지워진다
  ins.run(t(11), t(11, 30), today);     // 멀쩡함

  const check = (await call('GET', '/api/storage/integrity')).data;
  const issue = check.issues.find((i) => i.key === 'session_overlap');
  assert.ok(issue, `겹친 세션을 못 찾았습니다: ${check.issues.map((i) => i.key).join(', ')}`);
  assert.equal(issue.count, 2);

  const res = (await call('POST', '/api/storage/repair')).data;
  assert.equal(res.repaired.session_overlap, 2);
  assert.equal(res.ok, true, `고친 뒤에도 문제가 남았습니다: ${JSON.stringify(res.issues)}`);

  const rows = db.prepare('SELECT started_at, ended_at FROM focus_sessions ORDER BY started_at').all();
  assert.equal(rows.length, 3, '완전히 덮인 세션 하나만 사라져야 합니다');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].started_at >= rows[i - 1].ended_at, '고친 뒤에도 겹칩니다');
  }
  assert.equal(rows[1].started_at, t(10), '걸친 세션은 앞선 세션이 끝난 뒤로 밀린다');

  // 진행 중인 세션은 건드리지 않는다.
  db.prepare('DELETE FROM focus_sessions').run();
  db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (NULL, 'focus', 25, ?, NULL, 'running', '', ?)`,
  ).run(t(13), today);
  await call('POST', '/api/storage/repair');
  const running = db.prepare("SELECT * FROM focus_sessions WHERE status = 'running'").get();
  assert.equal(running.started_at, t(13), '진행 중인 세션을 건드리면 안 됩니다');

  db.prepare('DELETE FROM focus_sessions').run();
});

test('자리를 비운 채 그 구간을 정리해도 기록이 계속 자라지 않는다', async () => {
  // 추적기가 붙잡고 있는 자리비움 행을 "회의" 로 바꾸면, 놓아 주지 않는 한 추적기는
  // 여전히 자리비움인 줄 알고 그 행을 계속 늘린다 — 40분이라고 적어 둔 회의가
  // 자리에 돌아올 때까지 자란다.
  const { db } = await import('../server/lib/db.mjs');
  const { tracker } = await import('../server/tracker/tracker.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const start = Date.parse(`${today}T09:00:00`);
  const end = start + 40 * 60_000;
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('(자리비움)', '', '', ?, ?, 2400, 1, NULL, ?)`,
  ).run(start, end, today);
  const id = db.prepare('SELECT id FROM activity ORDER BY id DESC LIMIT 1').get().id;

  // 추적기가 이 행을 붙잡고 있는 상태를 만든다.
  tracker.open = {
    id, app: '(자리비움)', proc: '', title: '', started_at: start, day: today, idle: 1, category_id: null,
  };

  const cats = (await call('GET', '/api/categories')).data;
  const meeting = cats.find((c) => c.name === '회의');
  const resolved = (await call('POST', `/api/activity/${id}/resolve`, {
    app: '주간 회의', title: '', category_id: meeting.id,
  })).data;

  assert.equal(resolved.idle, 0);
  assert.equal(resolved.app, '주간 회의');
  assert.equal(tracker.open, null, '추적기가 그 행을 놓아야 합니다');
  assert.equal(tracker.adoptOnNextOpen, true, '다음 샘플에서 새로 열 준비가 되어야 합니다');

  db.prepare('DELETE FROM activity').run();
});

test('검색은 활동뿐 아니라 메모도 뒤진다', async () => {
  // 사람이 직접 쓴 것은 회고와 주간 약속뿐인데, 정작 그것만 찾을 방법이 없었다.
  // "지난번에 뭘 지키기로 했더라" 는 활동 기록이 아니라 자기가 쓴 문장에서 나오는 답이다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM notes').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T10:00:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Word', '분기 보고서 초안', '', ?, ?, 600, 0, NULL, ?)`,
  ).run(base, base + 600_000, today);

  await call('POST', '/api/notes/append', { day: today, text: '이번 주 약속 — 오전엔 메신저를 닫는다' });
  await call('POST', '/api/notes/append', { day: today, text: '회고 — 분기 보고서가 생각보다 오래 걸렸다' });

  const byNote = (await call('GET', '/api/activity/search?q=%EC%95%BD%EC%86%8D')).data;
  assert.equal(byNote.matches, 0, '활동에는 없는 낱말이다');
  assert.equal(byNote.notes.length, 1);
  assert.equal(byNote.notes[0].lines.length, 1, '맞은 줄만 골라야 한다 — 하루치를 통째로 쏟지 않는다');
  assert.match(byNote.notes[0].lines[0], /메신저를 닫는다/);

  // 활동과 메모에 모두 걸리는 낱말은 양쪽에서 나온다.
  const both = (await call('GET', '/api/activity/search?q=%EB%B6%84%EA%B8%B0')).data;
  assert.ok(both.matches >= 1, '활동에서도 찾아야 한다');
  assert.equal(both.notes.length, 1);
  assert.match(both.notes[0].lines[0], /오래 걸렸다/);

  // 없는 낱말은 양쪽 다 비어 있다.
  const none = (await call('GET', '/api/activity/search?q=%EC%97%86%EB%8A%94%EB%82%B1%EB%A7%90')).data;
  assert.equal(none.matches, 0);
  assert.equal(none.notes.length, 0);

  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM notes').run();
});

test('숫자여야 할 자리에 문자열이 든 백업은 거절한다', async () => {
  // SQLite 는 타입이 느슨해서 INTEGER 열에 문자열도 그대로 받는다. 그러면 가져오기는
  // 조용히 성공하고, 그 뒤로 시각 계산이 전부 NaN 이 된다 — 히트맵이 비고 합계가 사라지는데
  // 어디서부터 잘못됐는지 알 수 없다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T09:00:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('정상', '', '', ?, ?, 600, 0, NULL, ?)`,
  ).run(base, base + 600_000, today);

  const good = (await call('GET', '/api/export/all.json')).data;
  const before = db.prepare('SELECT COUNT(*) AS n FROM activity').get().n;

  for (const [field, value] of [['started_at', '2026-09-08 09:00'], ['seconds', '600'], ['idle', 'no']]) {
    const broken = structuredClone(good);
    broken.activity[0][field] = value;
    const res = await call('POST', '/api/import', { data: broken, mode: 'replace' });
    assert.equal(res.status, 400, `${field} 에 문자열이 들어왔는데 통과했습니다`);
    assert.match(res.data.error, new RegExp(`activity\.${field}`));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM activity').get().n, before,
      '거절된 가져오기가 기존 데이터를 건드렸습니다');
  }

  // 비어 있는 값(null)은 허용한다 — 선택 항목이 많다.
  const withNulls = structuredClone(good);
  withNulls.activity[0].category_id = null;
  withNulls.activity[0].task_id = null;
  assert.equal((await call('POST', '/api/import', { data: withNulls, mode: 'replace' })).status, 200);

  db.prepare('DELETE FROM activity').run();
});

test('시각이 망가진 기록이 섞여도 시간대 밀도가 비지 않는다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T10:00:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('정상', '', '', ?, ?, 1800, 0, NULL, ?)`,
  ).run(base, base + 1800_000, today);
  // 가져오기로는 이제 막히지만, 예전에 들어온 데이터에는 있을 수 있다.
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('망가짐', '', '', '어제', '오늘', 60, 0, NULL, ?)`,
  ).run(today);

  const report = (await call('GET', `/api/report/day?day=${today}`)).data;
  const hours = report.hourly;
  assert.ok(hours.every((b) => Number.isFinite(b.active) && Number.isFinite(b.idle)),
    `NaN 이 섞였습니다: ${JSON.stringify(hours.filter((b) => !Number.isFinite(b.active)))}`);
  assert.equal(hours[10].active, 1800, '멀쩡한 기록은 그대로 세어야 합니다');

  db.prepare('DELETE FROM activity').run();
});

test('시각이 숫자가 아닌 기록을 찾아내고 지운다', async () => {
  // 가져오기에서는 이제 막지만, 예전 판으로 들어왔거나 파일을 직접 손댄 경우가 있을 수 있다.
  // 남겨 두면 어느 지표에도 쓸 수 없으면서 계산만 망가뜨린다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T09:00:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('정상', '', '', ?, ?, 600, 0, NULL, ?)`,
  ).run(base, base + 600_000, today);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('망가짐', '', '', '어제', '오늘', '십분', 0, NULL, ?)`,
  ).run(today);

  const check = (await call('GET', '/api/storage/integrity')).data;
  const issue = check.issues.find((i) => i.key === 'bad_types');
  assert.ok(issue, `못 찾았습니다: ${check.issues.map((i) => i.key).join(', ')}`);
  assert.equal(issue.count, 1);

  const res = (await call('POST', '/api/storage/repair')).data;
  assert.equal(res.repaired.bad_types, 1);
  assert.equal(res.ok, true, `고친 뒤에도 문제가 남았습니다: ${JSON.stringify(res.issues)}`);

  const rows = db.prepare('SELECT app FROM activity').all();
  assert.deepEqual(rows.map((r) => r.app), ['정상'], '멀쩡한 기록까지 지우면 안 됩니다');

  db.prepare('DELETE FROM activity').run();
});

test('시각 자리에는 사람이 일하는 시간대의 값만 들어온다', async () => {
  // `int()` 만 걸어 두면 1e15 도, 음수도 그대로 저장된다. 실제로 태스크 기한에 그런 값을
  // 넣으면 "33658년 9월 27일" 이 저장되고 화면에는 "기한 초과 1,091만 일" 이라고 뜬다.
  // ±8.64e15 를 넘기면 new Date() 가 Invalid Date 가 되어 그 뒤 계산이 전부 NaN 이 된다 —
  // 어디서부터 잘못됐는지 알 수 없는 종류의 고장이다.
  const task = (await call('POST', '/api/tasks', { title: '기한 검사' })).data;
  const { dayKey } = await import('../server/lib/time.mjs');
  const today = dayKey();

  const bad = [1e15, -1e15, 8.64e15, 253402300799999, 0, Date.UTC(1999, 11, 31)];
  for (const due of bad) {
    const res = await call('PATCH', `/api/tasks/${task.id}`, { due_at: due });
    assert.equal(res.status, 400, `${due} 가 기한으로 받아들여졌습니다`);
  }

  // 사람이 실제로 쓰는 값은 그대로 통과한다.
  const ok = Date.parse(`${today}T18:00:00`) + 7 * 86_400_000;
  assert.equal((await call('PATCH', `/api/tasks/${task.id}`, { due_at: ok })).data.due_at, ok);
  // 기한 없음도 그대로.
  assert.equal((await call('PATCH', `/api/tasks/${task.id}`, { due_at: null })).data.due_at, null);

  // 다른 시각 자리들도 같은 기준을 쓴다 — 한 군데만 막으면 나머지로 들어온다.
  assert.equal((await call('POST', '/api/activity/manual', {
    started_at: 1e15, minutes: 30, app: '엉뚱한 시각',
  })).status, 400);
  assert.equal((await call('POST', '/api/activity/range', {
    from: -1e15, to: -1e15 + 3600_000, category_id: 1,
  })).status, 400);
  assert.equal((await call('POST', '/api/sessions/record', {
    start: 8.64e15, end: 8.64e15 + 60_000,
  })).status, 400);

  await call('DELETE', `/api/tasks/${task.id}`);
});

test('태스크 순서 바꾸기 — 드래그와 Alt+화살표가 쓰는 길', async () => {
  // 화면에서 순서를 바꾸는 유일한 경로인데 검사가 없었다. 여기가 조용히 깨지면
  // 드래그해도 제자리로 돌아오고, 사용자는 "왜 안 되지" 만 반복하게 된다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare("DELETE FROM tasks WHERE title LIKE '순서검사%'").run();

  const made = [];
  for (const n of ['순서검사 A', '순서검사 B', '순서검사 C']) {
    made.push((await call('POST', '/api/tasks', { title: n })).data);
  }
  const order = (list) => db.prepare(
    `SELECT id, sort_order FROM tasks WHERE id IN (${list.map(() => '?').join(',')}) ORDER BY sort_order`,
  ).all(...list).map((r) => r.id);

  const ids = made.map((t) => t.id);
  const reversed = [...ids].reverse();
  const res = (await call('POST', '/api/tasks/reorder', { ids: reversed })).data;
  assert.equal(res.reordered, 3);
  assert.deepEqual(order(ids), reversed, '넘긴 차례대로 정렬되어야 합니다');

  // 다시 되돌린다.
  await call('POST', '/api/tasks/reorder', { ids });
  assert.deepEqual(order(ids), ids);

  // 검증
  assert.equal((await call('POST', '/api/tasks/reorder', { ids: '아니오' })).status, 400);
  assert.equal((await call('POST', '/api/tasks/reorder', { ids: ['a'] })).status, 400);
  assert.equal(
    (await call('POST', '/api/tasks/reorder', { ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status,
    400, '한 번에 너무 많으면 거절한다',
  );

  for (const t of made) await call('DELETE', `/api/tasks/${t.id}`);
});

test('태스크 목록은 프로젝트와 검색어로 거를 수 있다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  db.prepare("DELETE FROM tasks WHERE title LIKE '거르기%'").run();
  db.prepare("DELETE FROM projects WHERE name LIKE '거르기%'").run();

  const proj = (await call('POST', '/api/projects', { name: '거르기 프로젝트' })).data;
  const inProject = (await call('POST', '/api/tasks', {
    title: '거르기 안쪽 태스크', project_id: proj.id, notes: '메모에만 있는 낱말 딸기',
  })).data;
  const outside = (await call('POST', '/api/tasks', { title: '거르기 바깥 태스크' })).data;

  const byProject = (await call('GET', `/api/tasks?project_id=${proj.id}`)).data;
  assert.deepEqual(byProject.map((t) => t.id), [inProject.id]);

  // 제목으로 찾기
  const byTitle = (await call('GET', '/api/tasks?q=%EA%B1%B0%EB%A5%B4%EA%B8%B0%20%EB%B0%94%EA%B9%A5')).data;
  assert.deepEqual(byTitle.map((t) => t.id), [outside.id]);

  // 메모로도 찾는다 — 제목에 없는 낱말이라도.
  const byNote = (await call('GET', '/api/tasks?q=%EB%94%B8%EA%B8%B0')).data;
  assert.deepEqual(byNote.map((t) => t.id), [inProject.id], '메모까지 뒤져야 합니다');

  await call('DELETE', `/api/tasks/${inProject.id}`);
  await call('DELETE', `/api/tasks/${outside.id}`);
  await call('DELETE', `/api/projects/${proj.id}`);
});

test('프로젝트의 주간 목표와 순서를 고치고 지운다', async () => {
  const { db } = await import('../server/lib/db.mjs');
  db.prepare("DELETE FROM projects WHERE name LIKE '목표검사%'").run();

  const proj = (await call('POST', '/api/projects', { name: '목표검사 프로젝트' })).data;
  assert.equal(proj.weekly_target_min, null);

  const withTarget = (await call('PATCH', `/api/projects/${proj.id}`, { weekly_target_min: 600 })).data;
  assert.equal(withTarget.weekly_target_min, 600);

  const moved = (await call('PATCH', `/api/projects/${proj.id}`, { sort_order: 42 })).data;
  assert.equal(moved.sort_order, 42);

  // 목표를 지울 수도 있어야 한다.
  assert.equal((await call('PATCH', `/api/projects/${proj.id}`, { weekly_target_min: null })).data.weekly_target_min, null);

  // 범위를 벗어난 값은 거절한다.
  assert.equal((await call('PATCH', `/api/projects/${proj.id}`, { weekly_target_min: 5 })).status, 400);
  assert.equal((await call('PATCH', `/api/projects/${proj.id}`, { sort_order: -1 })).status, 400);

  // 프로젝트를 지워도 태스크는 남고 연결만 풀린다.
  const task = (await call('POST', '/api/tasks', { title: '목표검사 태스크', project_id: proj.id })).data;
  assert.equal((await call('DELETE', `/api/projects/${proj.id}`)).data.deleted, proj.id);
  const after = (await call('GET', `/api/tasks/${task.id}`)).data;
  assert.equal(after.project_id, null, '프로젝트를 지웠다고 태스크까지 사라지면 안 됩니다');
  assert.equal((await call('DELETE', `/api/projects/${proj.id}`)).status, 404);

  await call('DELETE', `/api/tasks/${task.id}`);
});

test('세션의 메모·태스크·계획 시간을 나중에 고칠 수 있다', async () => {
  // 세션을 끝낸 뒤에야 "이건 어느 태스크였지" 를 정리하는 일이 잦다.
  // 이 경로가 조용히 깨지면 지난 세션을 손볼 방법이 아예 없어진다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM focus_sessions').run();

  const task = (await call('POST', '/api/tasks', { title: '세션수정 검사' })).data;
  const started = (await call('POST', '/api/sessions', { planned_min: 25, kind: 'focus' })).data;
  assert.equal(started.task_id, null);

  const bumped = (await call('POST', `/api/sessions/${started.id}/interrupt`)).data;
  assert.equal(bumped.interruptions, 1);
  assert.equal((await call('POST', `/api/sessions/${started.id}/interrupt`)).data.interruptions, 2);

  const patched = (await call('PATCH', `/api/sessions/${started.id}`, {
    note: '설계 리뷰였음', task_id: task.id, planned_min: 50,
  })).data;
  assert.equal(patched.note, '설계 리뷰였음');
  assert.equal(patched.task_id, task.id);
  assert.equal(patched.planned_min, 50);
  assert.equal(patched.task_title, '세션수정 검사', '태스크 이름이 따라와야 화면에서 보인다');

  // 아무것도 안 보내면 그대로 돌려준다.
  assert.equal((await call('PATCH', `/api/sessions/${started.id}`, {})).data.note, '설계 리뷰였음');

  // 검증
  assert.equal((await call('PATCH', `/api/sessions/${started.id}`, { task_id: 999999 })).status, 400);
  assert.equal((await call('PATCH', `/api/sessions/${started.id}`, { planned_min: 0 })).status, 400);
  assert.equal((await call('PATCH', '/api/sessions/999999', { note: 'x' })).status, 404);
  assert.equal((await call('POST', '/api/sessions/999999/interrupt')).status, 404);

  // 끝낼 때 메모를 함께 남길 수 있다.
  const ended = (await call('POST', `/api/sessions/${started.id}/end`, {
    status: 'done', note: '끝내며 남긴 메모',
  })).data;
  assert.equal(ended.note, '끝내며 남긴 메모');
  assert.equal(ended.status, 'done');

  // 이미 끝난 세션에 다시 종료를 눌러도 그대로다.
  assert.equal((await call('POST', `/api/sessions/${started.id}/end`)).data.status, 'done');

  // 지우기
  assert.equal((await call('DELETE', `/api/sessions/${started.id}`)).data.deleted, started.id);
  assert.equal((await call('DELETE', `/api/sessions/${started.id}`)).status, 404);

  await call('DELETE', `/api/tasks/${task.id}`);
  db.prepare('DELETE FROM focus_sessions').run();
});

test('마크다운 요약에 근거가 되는 절들이 빠짐없이 들어간다', async () => {
  // 이 문서는 일지·주간보고에 그대로 붙는다. 절 하나가 조용히 빠지면 근거 없이 숫자만
  // 남은 보고가 되는데, 붙여 넣는 사람은 알아채기 어렵다.
  const { db } = await import('../server/lib/db.mjs');
  const { dayKey, shiftDay, weekOf } = await import('../server/lib/time.mjs');
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();
  db.prepare('DELETE FROM notes').run();
  db.prepare("DELETE FROM tasks WHERE title LIKE '문서검사%'").run();

  const today = dayKey();
  const deep = db.prepare("SELECT id FROM categories WHERE kind = 'deep' LIMIT 1").get().id;
  const ins = db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Code', 'a.mjs', '', ?, ?, ?, 0, ?, ?)`,
  );
  const seedDay = (day, hours) => {
    const [y, m, d] = day.split('-').map(Number);
    const start = new Date(y, m - 1, d, 9, 0).getTime();
    ins.run(start, start + hours * 3600_000, hours * 3600, deep, day);
  };

  // 기준선을 만들려면 최근에 기록된 날이 세 날 이상 있어야 한다.
  for (const n of [1, 2, 3, 4]) seedDay(shiftDay(today, -n), 3);
  seedDay(today, 5);

  // 완료한 태스크 + 세션 → 추정 정확도 절
  const task = (await call('POST', '/api/tasks', { title: '문서검사 태스크', estimate_min: 60 })).data;
  const base = Date.parse(`${today}T14:00:00`);
  db.prepare(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (?, 'focus', 60, ?, ?, 'done', '설계 검토', ?)`,
  ).run(task.id, base, base + 90 * 60_000, today);
  await call('PATCH', `/api/tasks/${task.id}`, { status: 'done' });

  await call('POST', '/api/notes/append', { day: today, text: '회고 — 오전에 잘 붙었다' });

  const md = (await call('GET', `/api/export/day.md?day=${today}`)).text;
  for (const section of ['## 시간 배분', '## 집중 세션', '## 태스크', '## 지표', '## 메모']) {
    assert.ok(md.includes(section), `${section} 절이 빠졌습니다`);
  }
  assert.match(md, /업무 구간 \d{2}:\d{2}/, '업무 구간 줄이 없습니다');
  assert.match(md, /평소\(최근 \d+일 중앙값/, '평소 대비 줄이 없습니다');
  assert.match(md, /회고 — 오전에 잘 붙었다/);
  assert.doesNotMatch(md, /undefined|NaN|\?분/);

  const weekMd = (await call('GET', `/api/export/week.md?day=${today}`)).text;
  const thisWeek = weekOf(today);
  const midWeek = thisWeek.filter((d) => d <= today).length < 7;
  assert.match(weekMd, /활동 .+ · 몰입 .+ · 몰입 블록/);
  if (midWeek) assert.match(weekMd, /이번 주는 아직 \d+일째입니다/, '주중 안내가 없습니다');
  assert.ok(weekMd.includes('## 추정 정확도'), '추정 정확도 절이 빠졌습니다');
  assert.match(weekMd, /추정 60분 → 실제 90분/);
  assert.doesNotMatch(weekMd, /undefined|NaN|\?분/);

  await call('DELETE', `/api/tasks/${task.id}`);
  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM focus_sessions').run();

  // 미분류가 많은 날은 내보낸 글에도 그 사실이 남아야 한다.
  //
  // 이 문서는 일지·주간보고에 그대로 붙는다. 화면에서만 "이 점수는 아직 하루를
  // 설명하지 못합니다" 라고 말하고 붙여 넣은 글에는 숫자만 남기면,
  // 정작 남이 읽는 자리에서 경고가 사라진다.
  const cats2 = (await call('GET', '/api/categories')).data;
  const otherCat = cats2.find((c) => c.kind === 'other');
  const deepCat = cats2.find((c) => c.kind === 'deep');
  const t0 = Date.parse(`${today}T09:00:00`);
  const put = (offsetMin, minutes, categoryId) => db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('x', '', '', ?, ?, ?, 0, ?, ?)`,
  ).run(t0 + offsetMin * 60_000, t0 + (offsetMin + minutes) * 60_000, minutes * 60, categoryId, today);
  put(0, 40, deepCat.id);
  put(40, 160, otherCat.id); // 미분류 80%

  const messyDay = (await call('GET', `/api/export/day.md?day=${today}`)).text;
  assert.match(messyDay, /활동의 80% 가 아직 분류되지 않아/, '하루 요약에 미분류 안내가 없습니다');

  const messyWeek = (await call('GET', `/api/export/week.md?day=${today}`)).text;
  assert.match(messyWeek, /활동의 \d+%\(.+\)가 아직 분류되지 않았습니다/, '주간 리포트에 미분류 안내가 없습니다');

  // 정리하고 나면 그 문장이 사라진다 — 남아 있으면 그것대로 거짓말이다.
  db.prepare('UPDATE activity SET category_id = ? WHERE category_id = ?').run(deepCat.id, otherCat.id);
  const cleanDay = (await call('GET', `/api/export/day.md?day=${today}`)).text;
  assert.doesNotMatch(cleanDay, /아직 분류되지 않아/);
  const cleanWeek = (await call('GET', `/api/export/week.md?day=${today}`)).text;
  assert.doesNotMatch(cleanWeek, /아직 분류되지 않았습니다/);

  db.prepare('DELETE FROM activity').run();
  db.prepare('DELETE FROM notes').run();
});

test('활동 기록 하나의 분류와 태스크를 고치고 지운다', async () => {
  // 타임라인에서 기록을 눌러 바로잡는 길이다. 분류가 틀렸을 때 사용자가 가장 먼저 쓰는 경로다.
  const { db } = await import('../server/lib/db.mjs');
  db.prepare('DELETE FROM activity').run();

  const today = (await call('GET', '/api/health')).data.today;
  const base = Date.parse(`${today}T11:00:00`);
  db.prepare(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('낯선앱', '무언가', '', ?, ?, 900, 0, NULL, ?)`,
  ).run(base, base + 900_000, today);
  const id = db.prepare('SELECT id FROM activity ORDER BY id DESC LIMIT 1').get().id;

  const cats = (await call('GET', '/api/categories')).data;
  const dev = cats.find((c) => c.name === '개발');
  const task = (await call('POST', '/api/tasks', { title: '기록수정 검사' })).data;

  const patched = (await call('PATCH', `/api/activity/${id}`, {
    category_id: dev.id, task_id: task.id,
  })).data;
  assert.equal(patched.category_id, dev.id);
  assert.equal(patched.task_id, task.id);
  assert.equal(patched.category_name, '개발', '화면에 보일 이름도 함께 와야 한다');
  assert.equal(patched.task_title, '기록수정 검사');

  // 연결을 풀 수도 있어야 한다.
  const cleared = (await call('PATCH', `/api/activity/${id}`, { task_id: null, category_id: null })).data;
  assert.equal(cleared.task_id, null);
  assert.equal(cleared.category_id, null);

  // 아무것도 안 보내면 그대로.
  assert.equal((await call('PATCH', `/api/activity/${id}`, {})).data.id, id);

  // 검증
  assert.equal((await call('PATCH', `/api/activity/${id}`, { category_id: 999999 })).status, 400);
  assert.equal((await call('PATCH', `/api/activity/${id}`, { task_id: 999999 })).status, 400);
  assert.equal((await call('PATCH', '/api/activity/999999', { task_id: null })).status, 404);

  assert.equal((await call('DELETE', `/api/activity/${id}`)).data.deleted, id);
  assert.equal((await call('DELETE', `/api/activity/${id}`)).status, 404);

  await call('DELETE', `/api/tasks/${task.id}`);
  db.prepare('DELETE FROM activity').run();
});

test('추적기 자가 진단이 실제로 돌아간다', { skip: process.platform !== 'win32' }, async () => {
  // "기록이 안 쌓입니다" 를 확인하러 오는 유일한 길이다. 여기가 깨지면 사용자는
  // 무엇이 잘못됐는지 알아낼 방법이 없다. 프로브를 진짜로 한 번 띄워 확인한다.
  const res = await call('POST', '/api/tracker/diagnose');
  assert.equal(res.status, 200);
  const { checks, ok } = res.data;

  const names = checks.map((c) => c.name);
  for (const name of ['플랫폼', '프로브 스크립트', 'PowerShell 실행', '프로브 응답']) {
    assert.ok(names.includes(name), `${name} 항목이 없습니다: ${names.join(', ')}`);
  }
  assert.ok(checks.every((c) => typeof c.ok === 'boolean' && typeof c.detail === 'string'));

  // 이 환경에서 프로브가 뜨는지와 무관하게, 결과는 사람이 읽을 수 있는 모양이어야 한다.
  if (ok) {
    assert.ok(res.data.sample, '성공했다면 샘플이 있어야 합니다');
    assert.equal(typeof res.data.sample.idleMs, 'number');
  } else {
    const failed = checks.find((c) => !c.ok);
    assert.ok(failed.detail.length > 3, '실패했다면 왜인지 말해야 합니다');
  }
});

test('말이 안 되는 요청에도 서버가 죽지 않는다', async () => {
  // 로컬 서버라도 브라우저 말고 다른 것이 두드릴 수 있다 — 포트 스캐너, 잘못 설정된 프록시,
  // 실수로 붙은 다른 프로그램. 한 번의 이상한 요청으로 추적이 멈추면 그날이 통째로 빈다.
  const cases = [
    ['GET http://[ HTTP/1.1', ['Host: 127.0.0.1'], /^HTTP\/1\.1 400/],
    ['GET /api/health HTTP/1.1', [], /^HTTP\/1\.1 400/],           // Host 없음
    ['POST /api/tasks HTTP/1.1', ['Host: 127.0.0.1'], /^HTTP\/1\.1 4\d\d/], // 본문 없는 POST
    ['GET /..%2f..%2fpackage.json HTTP/1.1', ['Host: 127.0.0.1'], /^HTTP\/1\.1 \d\d\d/],
  ];
  for (const [line, headers, expected] of cases) {
    const res = await rawRequest(line, headers);
    assert.match(res, expected, `${line} → ${res.slice(0, 40)}`);
  }

  // 그리고 그 뒤로도 멀쩡히 응답한다.
  assert.equal((await call('GET', '/api/health')).status, 200, '이상한 요청 뒤에 서버가 죽었습니다');
});

test('알 수 없는 메서드는 404 로 끝난다', async () => {
  const res = await rawRequest('PUT /api/tasks HTTP/1.1', ['Host: 127.0.0.1', 'Content-Length: 0']);
  assert.match(res, /^HTTP\/1\.1 404/);
  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('망가진 JSON 본문과 잘못된 색은 400 으로 거절한다', async () => {
  // 이 경로가 500 을 내면 오류 로그만 쌓이고 사용자는 무엇이 잘못됐는지 모른다.
  // 본문 없이 보내면 빈 객체로 읽혀 '제목 필요' 로 거절된다.
  const bad = await rawRequest('POST /api/tasks HTTP/1.1',
    ['Host: 127.0.0.1', 'Content-Type: application/json', 'Content-Length: 0']);
  assert.match(bad, /^HTTP\/1\.1 400/);

  const broken = await new Promise((resolve, reject) => {
    const socket = net.connect(server.address().port, '127.0.0.1', () => {
      const body = '{"title": 이건JSON아님}';
      socket.write([
        'POST /api/tasks HTTP/1.1', 'Host: 127.0.0.1',
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        'Connection: close', '', body,
      ].join(CRLF));
    });
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (c) => { buf += c; });
    socket.on('end', () => resolve(buf));
    socket.on('error', reject);
  });
  assert.match(broken, /^HTTP\/1\.1 400/);
  assert.match(broken, /JSON 파싱 실패/);

  // 색 형식 검증
  assert.equal((await call('POST', '/api/categories', { name: '색검사', kind: 'deep', color: '파랑' })).status, 400);
  assert.equal((await call('POST', '/api/categories', { name: '색검사', kind: 'deep', color: '#12345' })).status, 400);
  const okCat = (await call('POST', '/api/categories', { name: '색검사', kind: 'deep', color: '#ABCDEF' })).data;
  assert.equal(okCat.color, '#abcdef', '색은 소문자로 맞춰 저장한다');
  await call('DELETE', `/api/categories/${okCat.id}`);

  assert.equal((await call('GET', '/api/health')).status, 200);
});

test('정적 파일은 바뀌지 않았으면 304 로 끝낸다', async () => {
  // 매번 통째로 내려보내면 화면을 옮길 때마다 파일을 다시 읽는다.
  const first = await fetch(`${BASE}/app.js`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.ok(etag, 'ETag 가 없습니다');

  const second = await fetch(`${BASE}/app.js`, { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304, '같은 파일인데 다시 내려보냈습니다');
  assert.equal((await second.text()).length, 0);

  // 다른 ETag 면 다시 준다.
  const third = await fetch(`${BASE}/app.js`, { headers: { 'if-none-match': 'W/"deadbeef"' } });
  assert.equal(third.status, 200);
});

/**
 * 화면이 읽는 `report.targets.*` 를 서버가 실제로 보내는지.
 *
 * "15분 이상 연속 구간" 처럼 설정으로 바꿀 수 있는 숫자가 화면 문장에 박혀 있었다.
 * 40분으로 바꿔 둔 사람에게는 화면이 그냥 거짓말을 하고 있었던 셈이라, 판정에 쓰는
 * 값을 서버가 함께 내려 주고 화면이 그것을 읽도록 바꿨다.
 *
 * 그런데 이 방식은 새로운 어긋남을 하나 만든다 — 화면이 `targets.block_min` 을 읽는데
 * 서버가 그 이름을 안 보내면 문장에 **`undefined분`** 이 그대로 찍힌다. 오류도 아니고
 * 빈칸도 아니라서, 그 화면을 실제로 열어 보기 전까지 아무도 모른다.
 * 그래서 화면이 읽는 이름을 소스에서 긁어 서버 응답과 대조한다.
 */
test('화면이 읽는 targets 키를 서버가 모두 보낸다', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  const wanted = new Set();
  for (const dir of ['web/views', 'web/lib']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(root, dir, f), 'utf8');
      for (const m of src.matchAll(/\btargets\.(\w+)/g)) wanted.add(m[1]);
    }
  }
  assert.ok(wanted.size >= 3, `화면에서 targets 를 하나도 못 찾았습니다 — 정규식이 헛돌고 있습니다`);

  const report = await (await fetch(`${BASE}/api/report/day`)).json();
  const missing = [...wanted].filter((k) => !(k in report.targets));
  assert.deepEqual(missing, [],
    `서버가 안 보내는 값을 화면이 읽고 있습니다: ${missing.join(', ')} — 문장에 "undefined" 가 찍힙니다`);

  // 값이 있어도 숫자가 아니면 문장이 깨진다.
  for (const k of wanted) {
    assert.equal(typeof report.targets[k], 'number', `targets.${k} 가 숫자가 아닙니다`);
  }
});

/**
 * 설정을 바꾸면 `targets` 도 따라 바뀌는지.
 *
 * 값을 내려보내기만 하고 설정과 연결되어 있지 않으면, 화면은 여전히 고정된 숫자를
 * 보여 주면서 이제는 그럴듯해 보이기까지 한다.
 */
test('몰입 블록·집중 시간 설정이 리포트 targets 에 반영된다', async () => {
  const before = await (await fetch(`${BASE}/api/report/day`)).json();

  await fetch(`${BASE}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ analytics_deep_block_min: 42, default_focus_min: 55 }),
  });
  const after2 = await (await fetch(`${BASE}/api/report/day`)).json();
  assert.equal(after2.targets.block_min, 42, '몰입 블록 최소 길이가 반영되지 않았습니다');
  assert.equal(after2.targets.focus_min, 55, '기본 집중 시간이 반영되지 않았습니다');

  // 원래대로 돌려 놓는다 — 뒤에 오는 검사가 이 값을 물려받지 않도록.
  await fetch(`${BASE}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      analytics_deep_block_min: before.targets.block_min,
      default_focus_min: before.targets.focus_min,
    }),
  });
});

/**
 * 첫 실행 안내가 정말 첫 실행에만 뜨는지.
 *
 * 화면은 "오늘이 비었는가" 로 판단하고 있었다. 그러면 몇 달 쓴 사람이 하루 쉬고 온 날
 * 아침에 "Cadence 를 시작합니다 — 첫 태스크 만들기" 가 뜬다. 실제 데이터에서 그렇게
 * 뜨는 것을 보고 고쳤다. 어제까지의 기록이 있는데 오늘만 비어 있는 상태를 그대로 만들어
 * 확인한다 — 이 조건이 아니면 재현되지 않는다.
 */
test('기록이 있는 사람에게는 첫 실행 안내가 뜨지 않는다', async () => {
  const { run } = await import('../server/lib/db.mjs');
  const { dayKey, dayRange, shiftDay } = await import('../server/lib/time.mjs');

  const today = dayKey();
  const yesterday = shiftDay(today, -1);
  const empty = await (await fetch(`${BASE}/api/report/day?day=${today}`)).json();
  const hadHistory = empty.first_run === false;

  if (!hadHistory) {
    assert.equal(empty.first_run, true, '아무 기록도 없는데 첫 실행이 아니라고 합니다');
  }

  // 어제 기록을 하나 심는다. 오늘은 그대로 비워 둔다.
  const [start] = dayRange(yesterday);
  run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
     VALUES ('Code', 'x', 'code.exe', ?, ?, 600, 0, ?)`,
    start + 3_600_000, start + 4_200_000, yesterday,
  );

  const after2 = await (await fetch(`${BASE}/api/report/day?day=${today}`)).json();
  assert.equal(after2.active_sec, 0, '오늘은 비어 있어야 이 상황이 재현된다');
  assert.equal(after2.first_run, false,
    '어제까지 기록이 있는데도 첫 실행 안내를 띄웁니다 — 도구가 자기를 잊은 것처럼 보입니다');
});

/**
 * 이미 기록된 창 제목을 지우는 길이 있는지.
 *
 * '창 제목 수집' 을 끄는 것은 앞으로만 막는다. 끄는 사람이 걱정하는 것은 대개
 * 이미 남아 있는 쪽이다 — 문서 이름이나 거래처 이름이 창 제목에 들어가 있다는 걸
 * 뒤늦게 알아차리고 끄기 때문이다. 지울 방법이 없으면 남은 선택은 데이터베이스를
 * 통째로 버리는 것뿐이고, 그러면 몇 달치 기록을 함께 잃는다.
 *
 * 지우되 **숫자는 하나도 달라지지 않아야** 한다. 시간·앱·분류를 함께 날리면
 * 그건 지우기가 아니라 기록을 버리는 것이다.
 */
test('창 제목만 지우고 시간·앱·분류는 그대로 남는다', async () => {
  const { run, all } = await import('../server/lib/db.mjs');
  const { dayKey, dayRange } = await import('../server/lib/time.mjs');
  const day = dayKey();
  const [start] = dayRange(day);
  const category = (await (await fetch(`${BASE}/api/categories`)).json())[0];

  run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Word', '2026년 3분기 홍길동 계약서.docx', 'winword.exe', ?, ?, 1800, 0, ?, ?)`,
    start + 7_200_000, start + 9_000_000, category.id, day,
  );

  const before = await (await fetch(`${BASE}/api/storage`)).json();
  assert.ok(before.titled > 0, '제목이 남은 기록이 있어야 이 검사가 뜻이 있습니다');
  const dayBefore = await (await fetch(`${BASE}/api/report/day?day=${day}`)).json();

  const res = await (await fetch(`${BASE}/api/storage/forget-titles`, { method: 'POST' })).json();
  assert.equal(res.cleared, before.titled);
  assert.ok(res.snapshot, '되돌릴 사본을 남기지 않았습니다 — 되돌릴 수 없는 일입니다');

  const rows = all("SELECT COUNT(*) AS n FROM activity WHERE title <> ''");
  assert.equal(rows[0].n, 0, '제목이 남아 있습니다');

  // 지운 뒤에도 하루의 숫자는 그대로여야 한다.
  const dayAfter = await (await fetch(`${BASE}/api/report/day?day=${day}`)).json();
  assert.equal(dayAfter.active_sec, dayBefore.active_sec, '활동 시간이 달라졌습니다');
  assert.deepEqual(dayAfter.kinds, dayBefore.kinds, '분류별 시간이 달라졌습니다');
  assert.equal(dayAfter.top_apps.length, dayBefore.top_apps.length, '앱 목록이 달라졌습니다');

  // 지울 것이 없으면 사본도 만들지 않는다 — 누를 때마다 사본이 쌓이면 디스크만 먹는다.
  const again = await (await fetch(`${BASE}/api/storage/forget-titles`, { method: 'POST' })).json();
  assert.deepEqual(again, { cleared: 0, snapshot: null });
});
