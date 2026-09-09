/**
 * 데모 데이터 생성기.
 *
 *   CADENCE_DATA_DIR=./demo node scripts/seed-demo.mjs [일수]
 *
 * 실제 사용 데이터와 섞이지 않도록 반드시 CADENCE_DATA_DIR 을 지정해서 실행한다.
 * UI 를 확인하거나 분석 로직을 눈으로 검증할 때 쓴다.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 데이터 폴더를 정하는 것이 먼저다 — config.mjs 는 불러오는 순간 경로를 굳힌다.
// 그래서 정적 import 로는 늦고, 아래에서 동적으로 불러온다.
//
// 지정하지 않으면 저장소 안의 demo/ 를 쓴다. 예전에는 그냥 거절했는데, README 의
// `npm run demo` 를 그대로 따라 한 사람이 첫 걸음에서 오류를 만났다 —
// 안전장치가 지켜야 할 것은 "실제 데이터를 덮어쓰지 않는 것" 이지 "아무것도 못 하게" 가 아니다.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.CADENCE_DATA_DIR) {
  process.env.CADENCE_DATA_DIR = path.join(REPO_ROOT, 'demo');
  console.log('CADENCE_DATA_DIR 이 없어 저장소의 demo/ 를 씁니다 (실제 데이터는 건드리지 않습니다).');
}

const { db, run, get, tx } = await import('../server/lib/db.mjs');
const { seedDefaults } = await import('../server/lib/categorize.mjs');
const { dayKey, dayRange, shiftDay } = await import('../server/lib/time.mjs');
const { DATA_DIR } = await import('../server/lib/config.mjs');

// 이 스크립트는 활동·세션·태스크·프로젝트·노트를 전부 지우고 다시 만든다.
// 실제로 쓰는 폴더를 가리키고 있으면 멈춘다 — 되돌릴 수 없는 일이라 한 번 더 확인한다.
const REAL_DIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || '', 'Cadence')
  : path.join(os.homedir(), '.local', 'share', 'cadence');

if (path.resolve(DATA_DIR) === path.resolve(REAL_DIR) && !process.argv.includes('--force')) {
  console.error(`실제 데이터 폴더(${DATA_DIR})에는 데모를 심지 않습니다.`);
  console.error('여기 있던 기록이 통째로 지워집니다. 정말 그러려면 --force 를 붙이세요.');
  process.exit(1);
}

const DAYS = Number(process.argv[2] || 21);

seedDefaults();

const catId = (name) => get('SELECT id FROM categories WHERE name = ?', name)?.id ?? null;

const APPS = [
  { app: 'Visual Studio Code', cat: '개발', titles: ['tracker.mjs — cadence', 'analytics.mjs — cadence', 'today.js — cadence', 'schema.sql — billing'] },
  { app: 'Windows Terminal', cat: '개발', titles: ['npm test', 'git log', 'pytest -k report'] },
  { app: 'Google Chrome', cat: '설계·리서치', titles: ['SQLite WAL — docs', 'Deep work 관련 아티클', 'MDN — Intl.DateTimeFormat'] },
  { app: 'Google Chrome', cat: '방해요소', titles: ['YouTube — 추천 영상', 'Reddit — r/programming'] },
  { app: 'Slack', cat: '커뮤니케이션', titles: ['#dev-general', '#product', 'DM — 팀장'] },
  { app: 'Microsoft Outlook', cat: '커뮤니케이션', titles: ['받은편지함', '주간 보고 회신'] },
  { app: 'Zoom', cat: '회의', titles: ['주간 스프린트 리뷰', '1:1'] },
  { app: 'Microsoft Word', cat: '문서·작성', titles: ['설계 문서 v3.docx', '분기 보고서.docx'] },
  { app: 'Microsoft Excel', cat: '문서·작성', titles: ['비용 추정.xlsx'] },
  { app: 'Windows 탐색기', cat: '관리·잡무', titles: ['다운로드', '프로젝트 폴더'] },
];

const PROMISES = [
  '오전 10–12시는 메신저를 닫고 한 가지만 한다',
  '회의는 오후로 몰고 오전은 비워 둔다',
  '하루 끝에 5분 마무리를 거르지 않는다',
  '점심 직후 30분은 잡무만 처리한다',
];

const PROJECTS = [
  { name: 'Cadence 개발', color: '#5b8def' },
  { name: '분기 보고', color: '#e0a458' },
  { name: '인프라 정리', color: '#4f9d69' },
];

const TASK_TITLES = [
  ['자동 추적 유휴 판정 개선', 90], ['주간 리포트 초안 작성', 120], ['DB 마이그레이션 스크립트', 60],
  ['API 응답 스키마 정리', 45], ['분기 실적 데이터 취합', 180], ['배포 파이프라인 점검', 75],
  ['온보딩 문서 업데이트', 40], ['성능 프로파일링', 120], ['고객 피드백 정리', 50],
  ['테스트 커버리지 보강', 90], ['로그 수집 설정', 60], ['월간 회고 준비', 45],
];

function rand(min, max) { return min + Math.random() * (max - min); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

console.log(`데모 데이터를 생성합니다 → ${DATA_DIR} (${DAYS}일)`);

tx(() => {
  // 기존 데모 데이터 제거
  run('DELETE FROM activity');
  run('DELETE FROM focus_sessions');
  run('DELETE FROM tasks');
  run('DELETE FROM projects');
  run('DELETE FROM notes');

  const projectIds = PROJECTS.map((p) => {
    const res = run('INSERT INTO projects(name, color, archived, created_at, sort_order) VALUES (?, ?, 0, ?, ?)',
      p.name, p.color, Date.now(), 0);
    return Number(res.lastInsertRowid);
  });

  /**
   * 태스크는 하루아침에 열두 개가 생기지 않는다 — 주마다 몇 개씩 생기고, 예상한 만큼
   * 시간을 쓰면 끝난다. 예전에는 12개를 한꺼번에 만들고 21일치 활동의 35%를 아무 데나
   * 붙였는데, 그러면 2시간짜리 일에 실제 4시간 반이 붙는다. 데모를 처음 열어 본 사람은
   * "추정 정확도 3.9배" 를 보고 그 기능이 고장 났다고 생각한다.
   *
   * 그래서 여기서는 실제 쓰임에 가깝게 만든다.
   *  - 태스크는 날짜를 따라 생긴다.
   *  - 열려 있는 것 중에서 골라 일하고, 쓴 시간을 기록한다.
   *  - 예상 × (0.7~1.7) 만큼 쓰면 끝낸 것으로 본다 → 추정 정확도가 1 언저리에 모인다.
   */
  const open = [];        // 지금 열려 있는 태스크
  const budget = new Map();
  const spent = new Map();
  let titleCursor = 0;
  let sortOrder = 0;

  const createTask = (at) => {
    const [title, est] = TASK_TITLES[titleCursor % TASK_TITLES.length];
    const suffix = titleCursor >= TASK_TITLES.length ? ` (${Math.floor(titleCursor / TASK_TITLES.length) + 1}차)` : '';
    titleCursor++;
    const res = run(
      `INSERT INTO tasks(project_id, title, notes, status, importance, urgency, estimate_min, due_at, created_at, updated_at, sort_order)
       VALUES (?, ?, '', 'todo', ?, ?, ?, ?, ?, ?, ?)`,
      pick(projectIds), title + suffix,
      Math.floor(rand(0, 3)), Math.floor(rand(0, 3)), est,
      Math.random() < 0.4 ? at + rand(1, 7) * 86_400_000 : null,
      at, at, (sortOrder += 1000),
    );
    const id = Number(res.lastInsertRowid);
    open.push(id);
    budget.set(id, est * 60 * rand(0.7, 1.7));
    spent.set(id, 0);
    return id;
  };

  /** 열려 있는 것 중 하나. 없으면 null — 그 구간은 어느 태스크에도 붙지 않는다. */
  const takeTask = () => (open.length ? pick(open) : null);

  /** 쓴 시간을 적고, 예산을 넘기면 그 시각에 끝낸 것으로 한다. */
  const charge = (id, seconds, at) => {
    if (!id) return;
    spent.set(id, spent.get(id) + seconds);
    if (spent.get(id) < budget.get(id)) return;
    run(
      "UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?",
      Math.round(at), Math.round(at), id,
    );
    open.splice(open.indexOf(id), 1);
  };

  const today = dayKey();
  for (let d = DAYS - 1; d >= 0; d--) {
    const day = shiftDay(today, -d);
    const [dayStart] = dayRange(day);
    const dow = new Date(dayStart).getDay();
    // 월요일마다 두어 개, 그리고 열린 것이 너무 적으면 그때그때 새로 만든다.
    if (dow === 1 || open.length < 2) {
      const many = dow === 1 ? Math.floor(rand(2, 4)) : 1;
      for (let k = 0; k < many; k++) createTask(dayStart + rand(0, 2) * 3600_000);
    }
    if (dow === 0 || dow === 6) {
      if (Math.random() < 0.75) continue; // 주말은 대부분 비움
    }

    // 하루 시작 시각: 8~10시
    let cursor = dayStart + (rand(8, 10) - 4) * 3600_000;
    const endOfDay = dayStart + (rand(17.5, 20) - 4) * 3600_000;
    const focusQuality = rand(0.3, 1); // 날마다 몰입도가 다르게

    while (cursor < endOfDay) {
      // 몰입 구간을 만들 것인가, 산만한 구간을 만들 것인가
      const deepRun = Math.random() < focusQuality * 0.55;
      const runEnd = cursor + (deepRun ? rand(25, 95) : rand(8, 30)) * 60_000;
      // 한 번 몰입할 때는 한 가지 일을 한다 — 구간마다 태스크를 새로 뽑지 않는다.
      const runTask = deepRun && Math.random() < 0.7 ? takeTask() : null;

      while (cursor < runEnd && cursor < endOfDay) {
        const pool = deepRun
          ? APPS.filter((a) => ['개발', '문서·작성', '설계·리서치'].includes(a.cat))
          : APPS;
        const choice = pick(pool);
        const segLen = (deepRun ? rand(3, 18) : rand(0.5, 6)) * 60_000;
        const end = Math.min(cursor + segLen, endOfDay);
        const seconds = Math.round((end - cursor) / 1000);
        if (seconds > 5) {
          run(
            `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
             VALUES (?, ?, '', ?, ?, ?, 0, ?, ?, ?)`,
            choice.app, pick(choice.titles), Math.round(cursor), Math.round(end), seconds,
            catId(choice.cat), runTask, day,
          );
          charge(runTask, seconds, end);
        }
        cursor = end;
      }

      // 쉬는 시간 / 자리비움
      if (Math.random() < 0.65 && cursor < endOfDay) {
        const idleLen = rand(5, 45) * 60_000;
        const end = Math.min(cursor + idleLen, endOfDay);
        run(
          `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
           VALUES ('(자리비움)', '', '', ?, ?, ?, 1, NULL, ?)`,
          Math.round(cursor), Math.round(end), Math.round((end - cursor) / 1000), day,
        );
        cursor = end;
      }
    }

    // 집중 세션.
    //
    // 시작 시각을 따로따로 뽑으면 세션끼리 겹친다 — 실제 앱에서는 한 번에 하나만 열리므로
    // 있을 수 없는 모양이고, 그대로 두면 데모의 집중 시간과 태스크 투입 시간이 부풀어 오른다.
    // 그래서 시각 순으로 하나씩 놓는다.
    const sessionCount = Math.round(rand(1, 7) * focusQuality) + 1;
    let sessionCursor = dayStart + (8.5 - 4) * 3600_000;
    const sessionLimit = dayStart + (18 - 4) * 3600_000;
    for (let i = 0; i < sessionCount; i++) {
      const started = sessionCursor + rand(5, 45) * 60_000;
      const planned = pick([25, 25, 25, 50, 15]);
      const abandoned = Math.random() > focusQuality * 0.9;
      const actual = abandoned ? planned * rand(0.2, 0.7) : planned * rand(0.95, 1.25);
      const ended = started + actual * 60_000;
      if (ended > sessionLimit) break;
      const sessionTask = takeTask();
      run(
        `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, interruptions, note, day)
         VALUES (?, 'focus', ?, ?, ?, ?, ?, '', ?)`,
        sessionTask, planned, Math.round(started), Math.round(ended),
        abandoned ? 'abandoned' : 'done', Math.random() < 0.3 ? Math.floor(rand(1, 4)) : 0, day,
      );
      // 세션 시간도 태스크에 붙는다 — 예산에서 함께 뺀다.
      if (!abandoned) charge(sessionTask, Math.round(actual * 60), ended);
      sessionCursor = ended;
    }

    // 월요일 노트에는 그 주의 약속을 적는다 — 주간 리뷰가 실제로 하는 일이다.
    // 지난 주들은 되짚기까지 남겨 두고, 이번 주는 약속만 둔다(리뷰가 물어볼 수 있도록).
    if (dow === 1) {
      const promise = PROMISES[(DAYS - d) % PROMISES.length];
      const answer = pick(['지켰다', '반쯤 지켰다', '못 지켰다']);
      const isThisWeek = d < 7;
      const lines = [`- 09:05 이번 주 약속 — ${promise}`]
        .concat(isThisWeek ? [] : [`- 18:40 지난 약속 되짚기 — ${answer} ("${promise}")`]);
      run(
        `INSERT INTO notes(day, body, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(day) DO UPDATE SET body = excluded.body || notes.body`,
        day, `${lines.join('\n')}\n`, Date.now(),
      );
    }

    if (Math.random() < 0.5) {
      run('INSERT INTO notes(day, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(day) DO NOTHING',
        day, `- 오전에 ${pick(TASK_TITLES)[0]} 진행\n- 오후 리뷰에서 나온 의견 반영 필요\n`, Date.now());
    }
  }

  // 오늘 몫의 계획을 남겨 둔다.
  //
  // 계획이 비어 있으면 "오늘 하기로 한 일" 도, 그 아래 실현 가능성 진단도, "지금 시작할 일"
  // 도 데모에서 아예 보이지 않는다 — 도구의 하루가 어떻게 돌아가는지 보러 온 사람에게
  // 정작 그 부분이 빈칸으로 남는다.
  // planned_for 는 한 칸뿐이라 하루치만 의미가 있으므로, 마지막에 오늘로 몰아 둔다.
  // 마지막 날까지 일하다 보면 열린 것이 하나도 안 남을 수 있다 — 실제로도 그런 날이 있지만,
  // 데모에서 "오늘 할 일" 이 텅 비면 정작 보여 주려던 화면이 빈칸이 된다.
  const [todayStart] = dayRange(today);
  while (open.length < 3) createTask(todayStart + rand(1, 3) * 3600_000);

  for (const id of open.slice(0, 3)) {
    run(
      `UPDATE tasks SET planned_for = ?,
              status = CASE WHEN status = 'todo' THEN 'doing' ELSE status END
       WHERE id = ?`,
      today, id,
    );
  }
});

const counts = {
  activity: get('SELECT COUNT(*) AS n FROM activity').n,
  sessions: get('SELECT COUNT(*) AS n FROM focus_sessions').n,
  tasks: get('SELECT COUNT(*) AS n FROM tasks').n,
};
console.log('완료:', counts);
db.close();
