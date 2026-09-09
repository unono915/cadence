import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('tracker');
// 이 검사는 세그먼트 조립 로직만 본다 — 실제 PowerShell 프로브를 띄우지 않는다.
process.env.CADENCE_NO_TRACKER = '1';
const { all, run } = await import('../server/lib/db.mjs');
const { seedDefaults } = await import('../server/lib/categorize.mjs');
const { Tracker, sanitizeTitle } = await import('../server/tracker/tracker.mjs');
const { setDayStartHour } = await import('../server/lib/time.mjs');

seedDefaults();
setDayStartHour(4);

const POLL = 4000;

function freshTracker() {
  run('DELETE FROM activity');
  return new Tracker({ pollMs: POLL, idleThresholdS: 120 });
}

/** 활동 샘플 하나. idleMs 를 주지 않으면 활동 중으로 본다. */
function sample(t, app, title = '', idleMs = 0) {
  return { t, app, proc: app, title, idleMs };
}

function segments() {
  return all('SELECT app, title, started_at, ended_at, seconds, idle FROM activity ORDER BY started_at, id');
}

test('같은 앱이 이어지면 세그먼트 하나로 늘어난다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-04', 10, 0);
  for (let i = 0; i <= 10; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  const rows = segments();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds, 40);
});

test('앱이나 창 제목이 바뀌면 세그먼트가 나뉜다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-04', 10, 0);
  for (let i = 0; i < 5; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  for (let i = 5; i < 10; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'b.js'));
  for (let i = 10; i < 15; i++) tr.ingest(sample(t0 + i * POLL, 'Slack', '#general'));
  const rows = segments();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, 'a.js');
  assert.equal(rows[1].title, 'b.js');
  assert.equal(rows[2].app, 'Slack');
});

test('3초 미만의 스쳐 지나간 창은 버려진다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-04', 10, 0);
  tr.ingest(sample(t0, 'Code', 'a.js'));
  tr.ingest(sample(t0 + 1000, 'Explorer', '다운로드')); // 1초 만에 전환
  tr.ingest(sample(t0 + 2000, 'Code', 'a.js'));
  for (let i = 1; i < 5; i++) tr.ingest(sample(t0 + 2000 + i * POLL, 'Code', 'a.js'));
  const rows = segments();
  assert.ok(!rows.some((r) => r.app === 'Explorer'), '짧은 세그먼트가 남아 있으면 안 된다');
});

test('유휴는 마지막 입력 시각으로 소급해서 잘린다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-04', 10, 0);
  // 10:00 ~ 10:05 활동
  for (let i = 0; i <= 75; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  const lastInput = t0 + 75 * POLL;
  // 이후 입력 없음 — 임계값(120초)을 넘긴 시점에 감지
  tr.ingest(sample(lastInput + 124_000, 'Code', 'a.js', 124_000));

  const rows = segments();
  assert.equal(rows.length, 2);
  const [work, idle] = rows;
  assert.equal(work.idle, 0);
  // 활동 구간은 마지막 입력 시각에서 끝나야 한다 (임계값만큼 부풀지 않음)
  assert.equal(work.ended_at, lastInput);
  assert.equal(idle.idle, 1);
  assert.equal(idle.started_at, lastInput);
});

test('유휴에서 복귀하면 복귀 시각부터 새 세그먼트가 열린다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-04', 10, 0);
  // 실제 프로브처럼 4초마다 끊김 없이 샘플을 흘려보낸다.
  let t = t0;
  for (let i = 0; i <= 5; i++, t += POLL) tr.ingest(sample(t, 'Code', 'a.js'));
  const idleStart = t - POLL;

  // 10분 동안 입력 없음 — idleMs 가 계속 커진다.
  const returnAt = idleStart + 600_000;
  while (t < returnAt) {
    tr.ingest(sample(t, 'Code', 'a.js', t - idleStart));
    t += POLL;
  }
  // 복귀: 방금 입력이 있었고 앱도 바뀌었다.
  tr.ingest(sample(returnAt + 1000, 'Word', '보고서.docx', 1000));

  const rows = segments();
  assert.equal(rows.length, 3);
  assert.equal(rows[1].idle, 1);
  assert.equal(rows[1].ended_at, returnAt, '유휴는 복귀(마지막 입력) 시각에 끝나야 한다');
  assert.equal(rows[2].app, 'Word');
  assert.equal(rows[2].started_at, returnAt);
});

test('폴링이 오래 끊기면 그 공백은 기록되지 않는다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-04', 10, 0);
  for (let i = 0; i <= 5; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  const lastSeen = t0 + 5 * POLL;
  // 절전 등으로 2시간 공백 후 재개
  const resume = lastSeen + 2 * 3600_000;
  for (let i = 0; i <= 3; i++) tr.ingest(sample(resume + i * POLL, 'Code', 'a.js'));

  const rows = segments();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ended_at, lastSeen, '공백 이전 구간은 마지막 샘플에서 닫혀야 한다');
  assert.equal(rows[1].started_at, resume);
  const gapRecorded = rows.reduce((s, r) => s + r.seconds, 0);
  assert.ok(gapRecorded < 3600, `공백이 기록되면 안 된다 (기록 ${gapRecorded}초)`);
});

test('업무일 경계를 넘으면 세그먼트가 날짜별로 쪼개진다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-05', 3, 30); // 업무일 시작(04:00) 직전
  for (let i = 0; i * POLL <= 40 * 60_000; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'night.js'));
  const rows = all('SELECT day, seconds FROM activity ORDER BY started_at');
  const days = new Set(rows.map((r) => r.day));
  assert.ok(days.has('2026-05-04'), '경계 이전은 전날로');
  assert.ok(days.has('2026-05-05'), '경계 이후는 당일로');
});

test('제목 수집을 끄면 창 제목이 저장되지 않는다', async () => {
  const { setSetting } = await import('../server/lib/db.mjs');
  setSetting('capture_titles', '0');
  const tr = freshTracker();
  const t0 = at('2026-05-06', 10, 0);
  for (let i = 0; i <= 5; i++) tr.ingest(sample(t0 + i * POLL, 'Chrome', '비밀 문서 - 사내망'));
  const rows = segments();
  assert.equal(rows[0].title, '');
  assert.equal(rows[0].app, 'Chrome');
  setSetting('capture_titles', '1');
});

test('일시정지 중에는 샘플을 받아도 기록하지 않는다', () => {
  const tr = freshTracker();
  tr.pause();
  const t0 = at('2026-05-07', 10, 0);
  for (let i = 0; i <= 5; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  assert.equal(segments().length, 0);
});

test('서버를 다시 켜도 진행 중이던 자리비움이 중복 기록되지 않는다', () => {
  const t0 = at('2026-05-08', 9, 0);

  // 1) 첫 실행: 잠깐 일하다 자리를 뜬다.
  const first = freshTracker();
  first.adoptOnNextOpen = true; // start() 가 세우는 플래그를 직접 재현
  let t = t0;
  for (let i = 0; i <= 5; i++, t += POLL) first.ingest(sample(t, 'Code', 'a.js'));
  const idleStart = t - POLL;
  const stopAt = idleStart + 40 * 60_000;
  while (t < stopAt) {
    first.ingest(sample(t, 'Code', 'a.js', t - idleStart));
    t += POLL;
  }
  const afterFirst = segments();
  assert.equal(afterFirst.length, 2, '작업 구간 + 자리비움 구간');
  const idleRowId = all('SELECT id FROM activity WHERE idle = 1').pop().id;

  // 2) 서버 재시작: 새 추적기가 여전히 자리비움인 상태로 첫 샘플을 받는다.
  const second = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  second.adoptOnNextOpen = true;
  const resumeAt = stopAt + 5 * 60_000;
  second.ingest(sample(resumeAt, 'Code', 'a.js', resumeAt - idleStart));

  const rows = segments();
  assert.equal(rows.length, 2, `자리비움 행이 새로 생기면 안 된다 (현재 ${rows.length}개)`);
  const idleRows = all('SELECT id, started_at, ended_at FROM activity WHERE idle = 1');
  assert.equal(idleRows.length, 1);
  assert.equal(idleRows[0].id, idleRowId, '기존 행을 이어받아야 한다');
  assert.equal(idleRows[0].started_at, idleStart, '시작 시각은 그대로');
  assert.equal(idleRows[0].ended_at, resumeAt, '끝만 늘어난다');
});

test('일시정지 뒤 재개하면 멈춘 구간을 이어붙이지 않는다', () => {
  const tr = freshTracker();
  tr.adoptOnNextOpen = true;
  const t0 = at('2026-05-09', 9, 0);
  for (let i = 0; i <= 5; i++) tr.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  tr.pause();

  tr.paused = false;
  tr.lastSampleAt = 0;
  tr.adoptOnNextOpen = false; // resume() 이 하는 일
  const laterStart = t0 + 60 * 60_000;
  for (let i = 0; i <= 5; i++) tr.ingest(sample(laterStart + i * POLL, 'Code', 'a.js'));

  const rows = segments();
  assert.equal(rows.length, 2, '멈춘 구간은 공백으로 남고 새 구간이 열려야 한다');
  assert.equal(rows[1].started_at, laterStart);
});

test('부팅 이어받기는 같은 앱·제목이 바로 이어질 때만 동작한다', () => {
  const t0 = at('2026-05-10', 9, 0);
  const first = freshTracker();
  first.adoptOnNextOpen = true;
  for (let i = 0; i <= 5; i++) first.ingest(sample(t0 + i * POLL, 'Code', 'a.js'));
  const firstEnd = t0 + 5 * POLL;

  // 다른 앱으로 재시작하면 이어받지 않는다.
  const second = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  second.adoptOnNextOpen = true;
  for (let i = 0; i <= 3; i++) second.ingest(sample(firstEnd + i * POLL, 'Word', '보고서.docx'));
  assert.equal(segments().length, 2, '앱이 다르면 새 구간');

  // 시간이 한참 지난 뒤라면 같은 앱이어도 이어받지 않는다.
  const third = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  third.adoptOnNextOpen = true;
  const muchLater = firstEnd + 3 * 3600_000;
  for (let i = 0; i <= 3; i++) third.ingest(sample(muchLater + i * POLL, 'Word', '보고서.docx'));
  assert.equal(segments().length, 3, '시간이 떨어져 있으면 새 구간');
});

test('업무일 경계에서 잘린 자리비움도 재시작 뒤 이어받는다', () => {
  // 실제로 겪은 모양: 새벽까지 자리를 비운 채 04:00 에 구간이 잘리고,
  // 그 뒤 서버를 다시 켜면 기존 행의 시작(04:00)이 새 시작점(어젯밤 마지막 입력)보다 늦다.
  const first = freshTracker();
  first.adoptOnNextOpen = true;

  const lastInput = at('2026-05-11', 1, 0); // 새벽 1시에 마지막 입력
  let t = lastInput;
  for (let i = 0; i <= 2; i++, t += POLL) first.ingest(sample(t, 'Code', 'a.js'));
  const inputEnd = t - POLL;

  // 04:00 을 넘겨 아침까지 계속 자리비움.
  // 실제 프로브처럼 폴링 간격을 지켜야 한다 — 간격이 벌어지면 '공백'으로 보고 구간을 닫는다.
  const morning = at('2026-05-11', 6, 0);
  while (t < morning) {
    first.ingest(sample(t, 'Code', 'a.js', t - inputEnd));
    t += POLL;
  }

  const beforeRestart = all('SELECT id, day, idle FROM activity WHERE idle = 1 ORDER BY id');
  assert.equal(beforeRestart.length, 2, '경계에서 잘려 전날/당일 두 행이 있어야 한다');
  const todayIdleId = beforeRestart[1].id;

  // 서버 재시작 — 여전히 자리비움
  const second = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  second.adoptOnNextOpen = true;
  const resumeAt = morning + 2 * 60_000;
  second.ingest(sample(resumeAt, 'Code', 'a.js', resumeAt - inputEnd));

  const idleRows = all('SELECT id, ended_at FROM activity WHERE idle = 1 ORDER BY id');
  assert.equal(idleRows.length, 2, `재시작이 자리비움 행을 늘리면 안 된다 (현재 ${idleRows.length}개)`);
  assert.equal(idleRows[1].id, todayIdleId, '당일 행을 이어받아야 한다');
  assert.equal(idleRows[1].ended_at, resumeAt);
});

test('오래 꺼져 있었어도 그동안 입력이 없었다면 한 구간으로 잇는다', () => {
  // 예전에는 공백이 30분을 넘으면 무조건 새 자리비움 구간을 열었다. 그런데 자리비움은
  // '마지막 입력 시각' 으로 소급해 열리므로, 새로 연 구간이 먼저 있던 구간을 통째로
  // 덮어 버린다 — 같은 시간이 두 번 세어지고, 켤 때마다 한 줄씩 늘어난다.
  // 실제 기록에서 똑같은 시각으로 시작하는 자리비움이 열 줄 쌓여 있었다.
  const first = freshTracker();
  first.adoptOnNextOpen = true;
  const t0 = at('2026-05-12', 9, 0);
  let t = t0;
  for (let i = 0; i <= 2; i++, t += POLL) first.ingest(sample(t, 'Code', 'a.js'));
  const inputEnd = t - POLL;
  const stopAt = inputEnd + 20 * 60_000;
  while (t < stopAt) { first.ingest(sample(t, 'Code', 'a.js', t - inputEnd)); t += POLL; }

  const second = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  second.adoptOnNextOpen = true;
  const muchLater = stopAt + 90 * 60_000; // 한 시간 반 뒤에야 다시 켬
  second.ingest(sample(muchLater, 'Code', 'a.js', muchLater - inputEnd));

  const idleRows = all('SELECT started_at, ended_at FROM activity WHERE idle = 1');
  assert.equal(idleRows.length, 1, '자리비움 구간이 겹쳐서 두 줄이 되었습니다');
  assert.equal(idleRows[0].started_at, inputEnd, '마지막 입력 시각에서 시작한다');
  assert.equal(idleRows[0].ended_at, muchLater, '다시 켠 시점까지 이어진다');
});

test('밖에서 기록을 지워도 추적기가 사라진 행을 계속 붙잡지 않는다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-13', 9, 0);
  let t = t0;
  for (let i = 0; i <= 5; i++, t += POLL) tr.ingest(sample(t, 'Code', 'a.js'));

  const openId = all('SELECT id FROM activity ORDER BY id DESC LIMIT 1')[0].id;
  // 백업 복원·정리가 하는 일을 흉내 낸다: 붙잡고 있던 행을 밖에서 삭제.
  run('DELETE FROM activity WHERE id = ?', openId);
  tr.releaseOpenSegment();

  for (let i = 0; i <= 5; i++, t += POLL) tr.ingest(sample(t, 'Code', 'a.js'));

  const rows = segments();
  assert.equal(rows.length, 1, '새 구간이 정확히 하나 열려야 한다');
  assert.ok(rows[0].seconds > 0, '기록이 다시 흘러야 한다');
});

test('재시작을 여러 번 해도 자리비움 행이 한 개를 넘지 않는다', () => {
  // 실제로 겪은 문제를 그대로 재현한다: 자리를 비운 채 서버를 여러 번 껐다 켠다.
  const first = freshTracker();
  first.adoptOnNextOpen = true;
  const t0 = at('2026-05-14', 9, 0);
  let t = t0;
  for (let i = 0; i <= 5; i++, t += POLL) first.ingest(sample(t, 'Code', 'a.js'));
  const inputEnd = t - POLL;
  for (let i = 0; i < 200; i++, t += POLL) first.ingest(sample(t, 'Code', 'a.js', t - inputEnd));

  let last = first;
  for (let restart = 0; restart < 5; restart++) {
    const next = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
    next.adoptOnNextOpen = true;
    t += 30_000; // 재시작에 걸리는 시간
    next.ingest(sample(t, 'Code', 'a.js', t - inputEnd));
    for (let i = 0; i < 10; i++, t += POLL) next.ingest(sample(t, 'Code', 'a.js', t - inputEnd));
    last = next;
  }

  const idleRows = all('SELECT id, started_at, ended_at FROM activity WHERE idle = 1');
  assert.equal(idleRows.length, 1, `재시작 5회 뒤에도 자리비움 행은 하나여야 한다 (현재 ${idleRows.length}개)`);
  assert.equal(idleRows[0].started_at, inputEnd);
  assert.equal(idleRows[0].ended_at, t - POLL);
  assert.ok(last.open, '마지막 추적기가 구간을 잡고 있어야 한다');
});

test('이어받을 행은 id 가 아니라 마지막으로 기록되던 시각으로 고른다', () => {
  // 업무일 경계 분할은 "전날 조각"을 나중에 삽입하므로 id 가 더 크다.
  // id 로 고르면 몇 시간 전에 끝난 전날 행을 집게 되어 이어붙이기가 실패한다.
  run('DELETE FROM activity');
  const yesterdayEnd = at('2026-05-16', 3, 59, 59);
  const todayStart = at('2026-05-16', 4, 0);
  const now = at('2026-05-16', 6, 0);

  // 오늘 조각(작은 id)이 먼저, 전날 조각(큰 id)이 나중에 들어간 상태를 만든다.
  run(`INSERT INTO activity(id, app, title, exe, started_at, ended_at, seconds, idle, day)
       VALUES (5, '(자리비움)', '', '', ?, ?, ?, 1, '2026-05-16')`,
    todayStart, now - 30_000, Math.round((now - 30_000 - todayStart) / 1000));
  run(`INSERT INTO activity(id, app, title, exe, started_at, ended_at, seconds, idle, day)
       VALUES (14, '(자리비움)', '', '', ?, ?, ?, 1, '2026-05-15')`,
    at('2026-05-16', 0, 47), yesterdayEnd, 11526);

  const tr = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  tr.adoptOnNextOpen = true;
  tr.ingest(sample(now, 'Code', 'a.js', now - at('2026-05-16', 0, 47)));

  const rows = all('SELECT id, ended_at FROM activity ORDER BY id');
  assert.equal(rows.length, 2, `새 행이 생기면 안 된다 (현재 ${rows.length}개)`);
  assert.equal(tr.open.id, 5, '마지막까지 기록되던 오늘 행을 이어받아야 한다');
  assert.equal(rows.find((r) => r.id === 5).ended_at, now);
});

test('붙잡고 있던 행이 밖에서 사라지면 알아서 다시 연다', () => {
  const tr = freshTracker();
  const t0 = at('2026-05-17', 9, 0);
  let t = t0;
  for (let i = 0; i <= 5; i++, t += POLL) tr.ingest(sample(t, 'Code', 'a.js'));

  const openId = tr.open.id;
  // releaseOpenSegment 를 부르지 않고 밖에서 지운다 — 수동 삭제 같은 경우.
  run('DELETE FROM activity WHERE id = ?', openId);

  // 다음 샘플에서 UPDATE 가 아무 데도 닿지 않는 것을 스스로 알아채야 한다.
  tr.ingest(sample(t, 'Code', 'a.js'));
  assert.equal(tr.open, null, '사라진 행을 계속 붙잡고 있으면 안 된다');

  t += POLL;
  for (let i = 0; i < 5; i++, t += POLL) tr.ingest(sample(t, 'Code', 'a.js'));

  const rows = segments();
  assert.equal(rows.length, 1, '새 구간이 열려 기록이 다시 흘러야 한다');
  assert.ok(rows[0].seconds > 0);
});

test('현재 구간 상태에 카테고리가 함께 실린다', () => {
  // 집중 세션 중 이탈 알림은 "지금 보고 있는 것이 방해요소인가"를 이 값으로 판단한다.
  // 여기가 비면 알림이 조용히 죽어 버리는데, 화면에서는 티가 나지 않는다.
  const tr = freshTracker();
  const t0 = at('2026-03-04', 10);

  tr.ingest(sample(t0, 'Visual Studio Code', 'main.mjs'));
  const coding = tr.status().current;
  assert.equal(coding.category?.name, '개발');
  assert.equal(coding.category?.kind, 'deep');

  tr.ingest(sample(t0 + 60_000, 'Google Chrome', 'YouTube — 음악'));
  const drifting = tr.status().current;
  assert.equal(drifting.category?.kind, 'distraction');

  // 자리비움에는 카테고리가 없다 — 이탈로 오인하지 않도록.
  tr.ingest(sample(t0 + 120_000, 'Google Chrome', 'YouTube — 음악', 300_000));
  const idle = tr.status().current;
  assert.equal(idle.idle, true);
  assert.equal(idle.category, null);
});

test('재시작으로 이어받은 구간도 카테고리를 잃지 않는다', () => {
  const first = freshTracker();
  const t0 = at('2026-03-04', 14);
  first.ingest(sample(t0, 'Slack', 'general 채널'));
  first.ingest(sample(t0 + 8000, 'Slack', 'general 채널'));
  const before = first.status().current.category;
  assert.ok(before, '이어받기 전에 카테고리가 있어야 합니다');

  const second = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  second.adoptOnNextOpen = true;
  second.lastSampleAt = t0 + 8000;
  second.ingest(sample(t0 + 10_000, 'Slack', 'general 채널'));

  assert.equal(second.status().current.category?.id, before.id);
});

test('잠금 화면은 앱이 아니라 자리비움으로 기록한다', () => {
  // 화면을 잠그는 행위 자체가 입력이라, 유휴 판정만 믿으면 잠근 뒤 임계값만큼은
  // 'LockApp.exe' 를 쓴 시간으로 남는다. 많이 쓴 앱 목록에 잠금 화면이 오르는 건 우스운 일이다.
  const tr = freshTracker();
  const t0 = at('2026-03-05', 9);

  tr.ingest(sample(t0, 'Visual Studio Code', 'main.mjs'));
  tr.ingest(sample(t0 + 30_000, 'Visual Studio Code', 'main.mjs'));

  // 잠근 직후 — 아직 유휴 임계값(120초)에 한참 못 미친다.
  tr.ingest({ t: t0 + 34_000, app: 'LockApp.exe', proc: 'LockApp', title: '', idleMs: 2000 });
  tr.ingest({ t: t0 + 38_000, app: 'LockApp.exe', proc: 'LockApp', title: '', idleMs: 6000 });

  const rows = segments();
  assert.equal(rows.filter((r) => r.app === 'LockApp.exe').length, 0, '잠금 화면이 앱으로 남았습니다');
  const away = rows.filter((r) => r.idle === 1);
  assert.equal(away.length, 1);
  // 마지막 입력(= 잠근 시점)으로 소급해 잘린다.
  assert.equal(away[0].started_at, t0 + 32_000);
});

test('포그라운드 창을 알아내지 못한 샘플은 활동으로 세지 않는다', () => {
  const tr = freshTracker();
  const t0 = at('2026-03-05', 14);

  tr.ingest(sample(t0, 'Slack', 'general 채널'));
  tr.ingest({ t: t0 + 20_000, app: '', proc: '', title: '', idleMs: 1000 });
  tr.ingest({ t: t0 + 24_000, app: '', proc: '', title: '', idleMs: 5000 });

  const rows = segments();
  assert.equal(rows.filter((r) => r.app === 'Unknown').length, 0, "'Unknown' 이 활동으로 남았습니다");
  assert.ok(rows.some((r) => r.idle === 1), '자리비움으로 기록되어야 합니다');
});

test("예전 프로브가 지어내던 'Unknown' 도 활동으로 세지 않는다", () => {
  // 프로브는 이제 이름을 못 찾으면 빈 값을 내보내지만, 이미 그 이름으로 들어오는
  // 샘플(구버전 프로브가 남아 돌고 있는 경우)도 막아야 한다.
  const tr = freshTracker();
  const t0 = at('2026-03-05', 16);
  tr.ingest(sample(t0, 'Microsoft Excel', '예산.xlsx'));
  tr.ingest({ t: t0 + 20_000, app: 'Unknown', proc: '', title: '', idleMs: 1000 });
  assert.equal(segments().filter((r) => r.app === 'Unknown').length, 0);

  // 다만 프로세스 이름이 함께 있으면 그건 진짜로 'Unknown' 이라는 이름의 창이다.
  const tr2 = freshTracker();
  tr2.ingest({ t: t0, app: 'Unknown', proc: 'weird', title: '', idleMs: 0 });
  tr2.ingest({ t: t0 + 20_000, app: 'Unknown', proc: 'weird', title: '', idleMs: 0 });
  assert.equal(segments().filter((r) => r.app === 'Unknown' && r.idle === 0).length, 1);
});

test('화면보호기도 자리비움으로 본다', () => {
  const tr = freshTracker();
  const t0 = at('2026-03-05', 20);
  tr.ingest(sample(t0, 'Microsoft Word', '보고서.docx'));
  tr.ingest({ t: t0 + 20_000, app: 'Mystify', proc: 'scrnsave.scr', title: '', idleMs: 3000 });
  assert.equal(segments().filter((r) => r.app === 'Mystify').length, 0);
});

/**
 * 잠금은 `start()` 안에서 확인하는데, `start()` 는 그보다 먼저 플랫폼을 본다 —
 * Windows 가 아니면 "이 플랫폼에서는 안 됩니다" 하고 바로 돌아선다. 그래서 다른 곳에서는
 * 잠금 논리에 닿을 수가 없다. 억지로 닿게 하려고 순서를 바꾸는 것은 본말전도다:
 * 기록을 남기지 않는 플랫폼에서 이중 기록을 막을 이유가 없다.
 */
test('같은 데이터 폴더에서 추적기가 둘 돌지 않는다', { skip: process.platform !== 'win32' }, async () => {
  // 시작프로그램으로 이미 떠 있는데 포트만 바꿔 다시 띄우면 이 상황이 된다.
  // 추적기 둘이 같은 활동을 각자 기록하면 하루 합계가 조용히 두 배가 된다.
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { DATA_DIR } = await import('../server/lib/config.mjs');
  const lockPath = path.join(DATA_DIR, 'tracker.lock');

  const tr = new Tracker({ pollMs: POLL, idleThresholdS: 120 });

  // 다른 프로세스가 방금 심장박동을 남긴 상태.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, at: Date.now() }));
  assert.equal(tr.start(), false, '남이 잡고 있으면 시작하지 않는다');
  assert.match(tr.status().lastError, /같은 데이터 폴더/);

  // 죽은 프로세스가 남긴 잠금은, 심장박동이 아직 싱싱해도 걸림돌이 되지 않는다.
  // 강제 종료 뒤 곧바로 다시 켜면 이 상황이 된다 — 자기 자신의 유령에게 막히면 안 된다.
  const deadPid = 0x7ffffffe; // 존재할 수 없는 큰 pid
  fs.writeFileSync(lockPath, JSON.stringify({ pid: deadPid, at: Date.now() }));
  tr.lastError = null;
  tr.start();
  assert.equal(tr.lastError, null, '이미 죽은 프로세스의 잠금에 막혔습니다');
  tr.stop();

  // 낡은 잠금(죽은 프로세스)은 걸림돌이 되지 않는다.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 1, at: Date.now() - 10 * 60_000 }));
  tr.lastError = null;
  tr.start();
  assert.equal(tr.lastError, null, '낡은 잠금에 발이 묶였습니다');
  // 시작을 시도했으면 잠금은 내 것으로 바뀌어 있어야 한다.
  assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, process.pid);
  tr.stop();

  // 내가 남긴 잠금은 나를 막지 않는다.
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }));
  const mine = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
  mine.start();
  assert.equal(mine.lastError, null);
  mine.stop();

  // 멈추면 잠금을 놓는다.
  assert.equal(fs.existsSync(lockPath), false, '멈춘 뒤에도 잠금이 남아 있습니다');
});

test('자리를 비운 채 여러 번 켜도 같은 구간이 늘어나지 않는다', () => {
  // 자리비움은 '마지막 입력 시각' 으로 소급해 열린다. 그래서 자리를 비운 채 서버를
  // 여러 번 켜면 매번 똑같은 시작 시각의 행이 하나씩 생긴다 —
  // 실제 기록에서 00:47:54 로 시작하는 자리비움이 열 줄 쌓여 있었다.
  run('DELETE FROM activity');
  // 업무일 경계(04시)를 넘지 않는 시간대를 쓴다 — 경계에서 구간이 쪼개지는 것은 정상이라
  // 이 검사가 보려는 것과 섞인다.
  const t0 = at('2026-03-06', 9);
  const lastInput = t0;

  // 켰다 껐다를 다섯 번. 매번 공백이 30분을 넘겨 '재시작 이어받기' 가 포기하는 상황.
  for (let i = 0; i < 5; i++) {
    const tr = new Tracker({ pollMs: POLL, idleThresholdS: 120 });
    tr.adoptOnNextOpen = true;
    const now = t0 + (i + 1) * 45 * 60_000; // 45분씩 건너뛴다
    // 소급 시점은 매번 몇 밀리초씩 흔들린다 — 실제 기록이 그랬다. 정확히 일치하는지만
    // 보면 이 흔들림 때문에 중복이 그대로 쌓인다.
    const jitter = i * 37;
    tr.ingest({ t: now, app: 'X', proc: 'x', title: '', idleMs: now - lastInput + jitter });
    tr.ingest({ t: now + 4000, app: 'X', proc: 'x', title: '', idleMs: now + 4000 - lastInput + jitter });
  }

  const idleRows = segments().filter((r) => r.idle === 1);
  assert.equal(idleRows.length, 1, `자리비움 행이 ${idleRows.length}개 쌓였습니다`);
  assert.ok(Math.abs(idleRows[0].started_at - lastInput) < 200, '시작 시각이 마지막 입력 근처여야 합니다');
  // 마지막 실행까지 늘어나 있어야 한다.
  assert.equal(idleRows[0].ended_at, t0 + 5 * 45 * 60_000 + 4000);
});

test('시작 시각이 다르면 이어붙이지 않는다', () => {
  // 같은 앱이라도 실제로 새로 시작한 구간은 별개다.
  run('DELETE FROM activity');
  const t0 = at('2026-03-06', 9);
  const tr = freshTracker();
  tr.ingest(sample(t0, 'Slack', 'general'));
  tr.ingest(sample(t0 + 10_000, 'Code', 'a.js'));
  tr.ingest(sample(t0 + 20_000, 'Slack', 'general'));
  tr.ingest(sample(t0 + 30_000, 'Slack', 'general'));
  assert.equal(segments().filter((r) => r.app === 'Slack').length, 2);
});

test('창 제목의 보이지 않는 글자를 걷어 낸다', () => {
  // 제목은 다른 프로그램이 정한다. 방향 뒤집기(U+202E)를 넣으면 화면에서
  // `file<RLO>gnp.exe` 가 `fileexe.png` 로 보이고, 폭 없는 글자를 끼우면 서로 다른 제목이
  // 똑같아 보인다. 시간을 어디에 썼는지 읽는 도구에서 제목을 잘못 읽게 만드는 것은
  // 그 자체로 기록을 못 믿게 만드는 일이다.
  assert.equal(sanitizeTitle('file\u202Egnp.exe'), 'file gnp.exe');
  assert.equal(sanitizeTitle('a\u200bb'), 'a b');
  assert.equal(sanitizeTitle('tab\there\nnewline\rcr'), 'tab here newline cr');
  assert.equal(sanitizeTitle('  여러   공백  '), '여러 공백');

  // 내용 자체는 건드리지 않는다.
  assert.equal(sanitizeTitle('보고서 📊 v2 — 최종'), '보고서 📊 v2 — 최종');
  assert.equal(sanitizeTitle('한글 English 123 !@#'), '한글 English 123 !@#');
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle(null), '');

  // 실제 기록에서 나온 것들. 앱 이름 끝의 공백 하나 때문에 "많이 쓴 앱" 목록에
  // "Adobe Acrobat" 이 두 줄로 섰다 — 화면에서는 글자 하나 다르지 않았다.
  assert.equal(sanitizeTitle('Adobe Acrobat '), 'Adobe Acrobat');
  // 전각 공백(U+3000)도 공백이다. \s 에 걸리므로 함께 접힌다.
  assert.equal(sanitizeTitle('K-에듀파인　　　_WebDRM[25h] - Whale'),
    'K-에듀파인 _WebDRM[25h] - Whale');

  // 마이그레이션이 같은 함수로 이미 쌓인 기록을 다시 다듬는다. 두 번 돌려도
  // 결과가 달라지면 안 된다 — 아니면 마이그레이션마다 기록이 조금씩 바뀐다.
  for (const s of ['Adobe Acrobat ', 'a​b', '  여러   공백  ', 'K-에듀파인　_x']) {
    assert.equal(sanitizeTitle(sanitizeTitle(s)), sanitizeTitle(s), `두 번 다듬으면 달라집니다: ${s}`);
  }
});

test('어떤 창 제목이 들어와도 추적이 멈추지 않는다', () => {
  // 추적기는 무엇이 들어와도 계속 돌아야 한다 — 한 번 멈추면 그날이 통째로 빈다.
  const tr = freshTracker();
  let t = at('2026-07-01', 10);
  const hostile = [
    'before\u0000after',      // 널 바이트
    'a\uD800b',               // 짝 없는 대리쌍
    'x'.repeat(5000),         // 아주 긴 제목
    'file\u202Egnp.exe',      // 방향 뒤집기
    '',                       // 빈 제목
  ];
  for (const title of hostile) {
    tr.ingest({ t, app: '테스트앱', proc: 'test', title, idleMs: 0 });
    t += 10_000;
    tr.ingest({ t, app: '테스트앱', proc: 'test', title, idleMs: 0 });
    t += 10_000;
  }
  assert.equal(tr.status().lastError, null, `추적이 멈췄습니다: ${tr.status().lastError}`);
  const rows = all('SELECT title FROM activity ORDER BY id');
  assert.ok(rows.length >= 4, `기록이 남지 않았습니다 (${rows.length}건)`);
  for (const r of rows) {
    assert.ok(r.title.length <= 400, '제목 길이 제한이 지켜지지 않았습니다');
    assert.doesNotMatch(r.title, /[\u0000-\u001f\u202a-\u202e]/, '보이지 않는 글자가 남았습니다');
  }
});

test('일시정지는 구간을 닫고, 재개는 그 사이를 공백으로 남긴다', async () => {
  // 화면 왼쪽 아래 칩으로 누르는 길이다. 멈춘 동안의 시간이 기록에 섞이면
  // "자리에 없었는데 일한 것으로" 남는다.
  const { setting } = await import('../server/lib/db.mjs');
  const tr = freshTracker();
  const t0 = at('2026-08-03', 10);

  tr.ingest(sample(t0, 'Code', 'a.js'));
  tr.ingest(sample(t0 + 8000, 'Code', 'a.js'));
  assert.ok(tr.status().current, '멈추기 전에는 붙잡고 있는 구간이 있다');

  tr.pause();
  assert.equal(tr.paused, true);
  assert.equal(tr.status().current, null, '멈추면 붙잡고 있던 구간을 놓는다');
  assert.equal(setting('tracker_paused', '0'), '1', '다시 켤 때도 멈춘 상태를 기억해야 한다');

  // 멈춘 동안 들어온 샘플은 무시한다.
  const before = segments().length;
  tr.ingest(sample(t0 + 20_000, 'Code', 'a.js'));
  assert.equal(segments().length, before, '멈춘 동안에는 기록하지 않는다');

  tr.resume();
  assert.equal(tr.paused, false);
  assert.equal(setting('tracker_paused', '0'), '0');
  assert.equal(tr.adoptOnNextOpen, false, '일부러 멈춘 구간은 이어붙이지 않는다');

  // 재개 뒤 첫 샘플은 새 구간을 연다 — 멈춘 시간이 채워지지 않는다.
  tr.ingest(sample(t0 + 30_000, 'Code', 'a.js'));
  tr.ingest(sample(t0 + 34_000, 'Code', 'a.js'));
  const rows = segments();
  assert.equal(rows.length, before + 1);
  assert.equal(rows[rows.length - 1].started_at, t0 + 30_000, '멈춘 동안은 비어 있어야 한다');
  tr.stop();
});

test('폴링 주기를 바꿔도 돌지 않던 추적기를 켜지는 않는다', () => {
  const tr = freshTracker();
  assert.equal(tr.pollMs, POLL);
  tr.applySettings({ pollMs: 9000, idleThresholdS: 300 });
  assert.equal(tr.pollMs, 9000);
  assert.equal(tr.idleThresholdMs, 300_000);
  assert.equal(tr.status().running, false, '꺼져 있던 추적기가 설정 변경만으로 켜지면 안 된다');
});

test('프로브 출력이 조각나 들어와도 샘플을 놓치지 않는다', () => {
  // 파이프는 줄 단위로 오지 않는다. 한 줄이 두 조각으로 잘리거나 한 조각에 여러 줄이 온다.
  // 잘못 다루면 샘플이 통째로 사라지는데, 화면에는 "기록이 없네" 로만 보인다.
  const tr = freshTracker();
  const t0 = at('2026-08-04', 10);
  const line = (t, app) => JSON.stringify({ t, title: '', proc: app, app, idleMs: 0 });

  tr.onChunk('{"ready":true}\n');           // 준비 신호는 기록하지 않는다
  assert.equal(segments().length, 0);

  // 한 줄이 두 조각으로 잘려 온다.
  const whole = `${line(t0, 'Code')}\n`;
  tr.onChunk(whole.slice(0, 20));
  assert.equal(segments().length, 0, '반쪽만 왔을 때 섣불리 처리하면 안 된다');
  tr.onChunk(whole.slice(20));
  assert.equal(segments().length, 1, '나머지가 오면 처리해야 한다');

  // 한 조각에 여러 줄.
  tr.onChunk(`${line(t0 + 4000, 'Code')}\n${line(t0 + 8000, 'Slack')}\n`);
  const rows = segments();
  assert.deepEqual(rows.map((r) => r.app), ['Code', 'Slack']);

  // 깨진 줄은 건너뛰고 계속한다 — 한 줄 때문에 추적이 멈추면 안 된다.
  tr.onChunk('{이건 JSON 이 아님\n');
  tr.onChunk('\n\n');
  tr.onChunk(`${line(t0 + 12_000, 'Word')}\n`);
  assert.deepEqual(segments().map((r) => r.app), ['Code', 'Slack', 'Word']);
  assert.equal(tr.status().lastError, null);

  // 줄바꿈 없이 끝없이 밀려와도 메모리를 삼키지 않는다.
  tr.onChunk('x'.repeat(1_100_000));
  assert.ok(tr.buffer.length < 1000, `버퍼가 ${tr.buffer.length} 까지 자랐습니다`);
  // 버려진 뒤에도 다음 줄은 정상 처리된다.
  tr.onChunk(`\n${line(t0 + 16_000, 'Excel')}\n`);
  assert.deepEqual(segments().map((r) => r.app), ['Code', 'Slack', 'Word', 'Excel']);
});

test('샘플 처리 중 오류가 나도 추적기가 죽지 않는다', () => {
  const tr = freshTracker();
  // ingest 가 던지도록 만들어 둔다.
  const original = tr.ingest;
  tr.ingest = () => { throw new Error('일부러 낸 오류'); };
  tr.onChunk(`${JSON.stringify({ t: at('2026-08-04', 11), app: 'X', proc: 'x', title: '', idleMs: 0 })}\n`);
  assert.match(tr.status().lastError, /샘플 처리 오류/);
  tr.ingest = original;

  // 그 뒤로도 계속 받는다.
  const t1 = at('2026-08-04', 12);
  tr.onChunk(`${JSON.stringify({ t: t1, app: 'Y', proc: 'y', title: '', idleMs: 0 })}\n`);
  tr.onChunk(`${JSON.stringify({ t: t1 + 8000, app: 'Y', proc: 'y', title: '', idleMs: 0 })}\n`);
  assert.ok(segments().some((r) => r.app === 'Y'), '오류 뒤에도 기록을 이어가야 합니다');
});

test('프로브가 자꾸 죽으면 천천히, 오래 멀쩡했으면 곧바로 다시 띄운다', () => {
  // 재시작 대기는 지수로 늘어난다 — 실행 정책이나 백신에 막혀 즉시 죽는 상황에서
  // 초당 수십 번 PowerShell 을 띄우면 그것대로 기계를 망가뜨린다.
  //
  // 다만 **한동안 멀쩡히 돌았다면 처음부터 다시 센다.** 예전에는 누적 횟수로 계산해서
  // 아침에 다섯 번 죽은 기계는 저녁에 한 번 죽어도 30초를 기다렸다.
  // 그 30초는 기록에 그대로 구멍으로 남는데, 아침 일과는 아무 상관이 없다.
  const tr = freshTracker();
  const delays = [];
  // 실제 타이머를 걸지 않고 대기 시간만 받아 본다.
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return { unref() {} }; };

  try {
    // 띄우자마자 죽기를 되풀이하면 대기가 길어진다.
    for (let i = 0; i < 6; i++) {
      tr.startedAt = Date.now();
      tr.onExit(1);
    }
    assert.deepEqual(delays, [2000, 4000, 8000, 16000, 32000, 32000].map((x) => Math.min(30_000, x)),
      `대기 시간이 늘지 않습니다: ${delays.join(', ')}`);
    assert.equal(tr.restarts, 6, '누적 재시작 횟수는 그대로 센다');

    // 여섯 시간을 멀쩡히 돌았다면 다음 실패는 처음처럼 다룬다.
    delays.length = 0;
    tr.startedAt = Date.now() - 6 * 3600_000;
    tr.onExit(1);
    assert.deepEqual(delays, [2000], `오래 멀쩡했는데 ${delays[0]}ms 를 기다립니다`);
    assert.equal(tr.restarts, 7, '보고용 횟수는 계속 쌓인다');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    tr.stop();
  }
});
