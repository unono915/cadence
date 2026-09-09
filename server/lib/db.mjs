import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.mjs';
import { sanitizeTitle } from './text.mjs';

/**
 * 단일 SQLite 연결. node:sqlite 는 동기 API 이므로 별도 풀이 필요 없다.
 * WAL 모드로 열어 추적기 쓰기와 UI 읽기가 서로를 막지 않게 한다.
 *
 * 여는 데 실패하면 **읽을 수 있는 말로** 멈춘다. 이 줄은 모듈을 불러오는 순간 돌기 때문에,
 * 그냥 두면 사용자가 보는 것은 Node 의 원시 스택뿐이다 — `start.cmd` 로 띄웠다면
 * 창 가득 영문 스택이 뜨고 끝이다. 실제로 일어나는 일들이다: 정전 뒤 파일이 잘렸거나,
 * 백업 프로그램이 파일을 붙잡고 있거나, 동기화 폴더가 충돌 사본을 만들어 놨거나.
 *
 * 파일을 지우라고 함부로 권하지 않는다 — 그 안에 사용자의 기록 전부가 들어 있다.
 * 옆에 있는 자동 사본을 먼저 가리킨다.
 */
function openDatabase() {
  try {
    const conn = new DatabaseSync(DB_PATH);
    conn.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    return conn;
  } catch (err) {
    const busy = /busy|locked/i.test(err.message);
    console.error('');
    console.error('[cadence] 데이터베이스를 열지 못해 시작하지 못했습니다.');
    console.error(`  파일: ${DB_PATH}`);
    console.error(`  이유: ${err.message}`);
    console.error(busy
      ? '  다른 프로그램(백업·동기화 도구)이 이 파일을 붙잡고 있을 수 있습니다. 잠시 뒤 다시 실행해 보세요.'
      : '  같은 폴더의 cadence-backup-*.db 를 cadence.db 로 복사하면 그 시점으로 되돌릴 수 있습니다.');
    console.error('  (원본은 지우지 말고 다른 이름으로 옮겨 두세요 — 되살릴 여지가 남습니다.)');
    console.error('');
    process.exit(1);
  }
}

export const db = openDatabase();

/**
 * 순차 마이그레이션. 배열에 추가만 하고, 기존 항목은 절대 수정하지 않는다.
 * user_version 프래그마로 적용 지점을 기록한다.
 */
const MIGRATIONS = [
  // 1 — 최초 스키마
  `
  CREATE TABLE categories (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL DEFAULT 'other',
    color      TEXT NOT NULL DEFAULT '#8b8b8b',
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE projects (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    color      TEXT NOT NULL DEFAULT '#5b8def',
    archived   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    sort_order REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE tasks (
    id           INTEGER PRIMARY KEY,
    project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
    title        TEXT NOT NULL,
    notes        TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'todo',
    importance   INTEGER NOT NULL DEFAULT 1,
    urgency      INTEGER NOT NULL DEFAULT 1,
    estimate_min INTEGER,
    due_at       INTEGER,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    completed_at INTEGER,
    sort_order   REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_tasks_status ON tasks(status);
  CREATE INDEX idx_tasks_project ON tasks(project_id);

  CREATE TABLE focus_sessions (
    id            INTEGER PRIMARY KEY,
    task_id       INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    kind          TEXT NOT NULL DEFAULT 'focus',
    planned_min   INTEGER NOT NULL DEFAULT 25,
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER,
    status        TEXT NOT NULL DEFAULT 'running',
    interruptions INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT '',
    day           TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_day ON focus_sessions(day);
  CREATE INDEX idx_sessions_task ON focus_sessions(task_id);

  CREATE TABLE activity (
    id          INTEGER PRIMARY KEY,
    app         TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    exe         TEXT NOT NULL DEFAULT '',
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER NOT NULL,
    seconds     INTEGER NOT NULL,
    idle        INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    task_id     INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    day         TEXT NOT NULL
  );
  CREATE INDEX idx_activity_day ON activity(day);
  CREATE INDEX idx_activity_started ON activity(started_at);
  CREATE INDEX idx_activity_category ON activity(category_id);

  CREATE TABLE rules (
    id          INTEGER PRIMARY KEY,
    field       TEXT NOT NULL DEFAULT 'app',
    pattern     TEXT NOT NULL,
    is_regex    INTEGER NOT NULL DEFAULT 0,
    category_id INTEGER REFERENCES categories(id) ON DELETE CASCADE,
    priority    INTEGER NOT NULL DEFAULT 100,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE notes (
    day        TEXT PRIMARY KEY,
    body       TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // 2 — "오늘 하기로 한 일" 표시. 하루 계획과 실제를 비교하기 위한 것.
  `
  ALTER TABLE tasks ADD COLUMN planned_for TEXT;
  CREATE INDEX idx_tasks_planned ON tasks(planned_for);
  `,

  // 3 — 긴 자리비움을 사용자가 이미 확인했는지 표시. 같은 구간을 반복해서 묻지 않기 위한 것.
  `
  ALTER TABLE activity ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0;
  `,

  // 4 — 프로젝트별 주간 시간 예산. 기록을 보는 도구에서 계획을 검증하는 도구로 넘어가기 위한 것.
  `
  ALTER TABLE projects ADD COLUMN weekly_target_min INTEGER;
  `,

  // 5 — 태스크별 시간 집계용 인덱스.
  //
  // 태스크 목록과 기간 리포트는 "이 태스크에 붙은 활동 중 세션과 겹치지 않는 것"을 세는데,
  // activity.task_id 에 인덱스가 없어 태스크마다 활동 전체를 훑고 있었다.
  // 기록이 2만 건을 넘어가면 태스크 목록 한 번에 100ms 를 넘긴다 — 매 화면에서 부르는 질의라 치명적.
  `
  CREATE INDEX IF NOT EXISTS idx_activity_task_started ON activity(task_id, started_at);
  CREATE INDEX IF NOT EXISTS idx_sessions_task_started ON focus_sessions(task_id, started_at);
  `,

  // 6 — 잠금 화면과 정체를 알 수 없는 창을 뒤늦게 자리비움으로 돌린다.
  //
  // 추적기는 이제 이런 창을 활동으로 세지 않는다. 그런데 이미 쌓인 기록에는
  // 'LockApp.exe' 를 몇 분씩 쓴 것처럼 남아 있고, 많이 쓴 앱 목록에까지 올라온다.
  // 새 규칙을 과거에도 똑같이 적용해 두어야 어제와 오늘의 숫자가 같은 뜻을 갖는다.
  `
  UPDATE activity
     SET idle = 1, app = '(자리비움)', title = '', exe = '', category_id = NULL
   WHERE idle = 0
     AND (lower(exe) IN ('lockapp', 'logonui', 'lockappost')
          OR lower(exe) LIKE '%.scr'
          OR (app = 'Unknown' AND exe = ''));
  `,

  // 7 — 사람이 직접 정한 분류에 표시를 남긴다.
  //
  // 규칙을 하나 만들 때마다 `recategorizeAll()` 이 기존 기록을 다시 훑는데, 여기에는
  // 사용자가 손으로 "이 구간은 회의였다" 고 고쳐 둔 것까지 딸려 들어갔다. 규칙이 이기니까
  // 손으로 고친 분류는 다음 규칙 하나에 조용히 사라졌다 — 화면에는 아무 말도 없이.
  //
  // 손으로 정한 것은 규칙보다 정확하다. 사람이 그 시간에 무엇을 했는지 알기 때문이다.
  // 그래서 표시를 남기고, 재분류는 표시가 없는 것만 건드린다.
  //
  // 이미 쌓인 수동 입력(exe = 'manual')은 그 자체가 사람이 만든 기록이므로 함께 표시한다.
  // 반대로 구간 지정으로 고쳐 둔 자동 기록은 구분할 방법이 남아 있지 않다 — 되살리지 못한다.
  `
  ALTER TABLE activity ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  UPDATE activity SET pinned = 1 WHERE exe = 'manual' AND category_id IS NOT NULL;
  `,

  // 8 — 이미 쌓인 앱 이름과 창 제목의 공백을 지금 규칙대로 다시 다듬는다.
  //
  // 추적기는 이제 앞뒤 공백을 떼고 연속 공백을 하나로 줄인다. 그런데 그 전에 쌓인
  // 기록에는 "Adobe Acrobat " 처럼 뒤에 공백 하나가 붙은 이름이 남아 있다.
  // 화면에서는 앞의 것과 글자 하나 다르지 않은데 집계에서는 다른 앱이 되어,
  // "많이 쓴 앱" 목록에 같은 이름이 두 줄로 섰다. 보고서는 이유를 알 방법이 없다.
  //
  // SQL 의 TRIM 으로는 부족하다 — 전각 공백(U+3000)이나 폭 없는 글자는 그대로 남는다.
  // 그래서 추적기와 **같은 함수**로 다듬는다. 두 곳이 다른 규칙을 쓰면 결국 또 갈라진다.
  () => {
    const rows = db.prepare('SELECT id, app, title FROM activity').all();
    const upd = db.prepare('UPDATE activity SET app = ?, title = ? WHERE id = ?');
    for (const r of rows) {
      const app = sanitizeTitle(r.app);
      const title = sanitizeTitle(r.title);
      if (app === r.app && title === r.title) continue;
      upd.run(app, title, r.id);
    }
  },

  // 9 — 지난 세션의 완주 여부를 지금 기준으로 다시 매긴다.
  //
  // 종료 버튼이 상태를 붙이지 않으면 서버가 무조건 'done' 을 썼다. 그래서 25분을
  // 계획하고 12초 만에 끈 것도 완주로 남았고, 완주율은 언제나 100% 였다.
  // 이제는 계획의 8할을 채워야 완주다.
  //
  // 지난 기록을 그대로 두면 "완주율이 갑자기 떨어졌다" 로 보인다. 실제로는 기준이
  // 바뀐 것인데 사람은 자기가 나빠졌다고 읽는다. 어제와 오늘이 같은 뜻을 갖게 맞춰 둔다.
  // (되돌려 잰 세션은 planned_min 이 실제 길이와 같으므로 그대로 완주로 남는다.)
  //
  // 0.8 은 여기 그대로 적어 둔다. `DONE_RATIO` 를 끌어다 쓰고 싶겠지만, 마이그레이션은
  // 한 번 돌고 나면 다시 돌지 않는 **과거의 사실**이다. 상수를 따라가게 만들면 나중에
  // 기준을 바꿨을 때 이미 지나간 마이그레이션의 뜻이 소급해서 달라진다.
  `
  UPDATE focus_sessions
     SET status = 'abandoned'
   WHERE status = 'done'
     AND ended_at IS NOT NULL
     AND (ended_at - started_at) < planned_min * 60000 * 0.8;
  `,
];

function migrate() {
  const current = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      // SQL 로 표현하기 어려운 손질은 함수로 둔다 — 트랜잭션 안에서 도는 것은 같다.
      const step = MIGRATIONS[v];
      if (typeof step === 'function') step();
      else db.exec(step);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new Error(`마이그레이션 ${v + 1} 실패: ${err.message}`, { cause: err });
    }
  }
}

migrate();

/**
 * WAL 을 주기적으로 본 파일에 반영한다.
 *
 * 추적기가 몇 초마다 UPDATE 를 하므로 WAL 이 계속 자란다. SQLite 는 4MB 쯤에서 알아서
 * 정리하지만, 그때까지 **최근 기록은 cadence.db 가 아니라 -wal 파일에만** 있다.
 * 사용자에게 "데이터베이스 파일을 그대로 복사해도 된다"고 안내해 두었으므로,
 * 본 파일이 항상 최신에 가깝도록 우리가 먼저 넘겨 준다.
 *
 * TRUNCATE 는 반영할 것이 없으면 사실상 공짜다. 읽는 쪽을 막지도 않는다.
 */
export function startWalMaintenance({ intervalMs = 120_000 } = {}) {
  const timer = setInterval(() => {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // 다른 읽기가 진행 중이면 그냥 넘어간다 — 다음 주기에 다시 시도한다.
    }
  }, intervalMs);
  timer.unref?.();
  return timer;
}

/** 트랜잭션 헬퍼 — fn 이 throw 하면 롤백. */
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 이미 롤백됨 */ }
    throw err;
  }
}

export function get(sql, ...params) {
  return db.prepare(sql).get(...params);
}

export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}

export function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    String(value),
  );
}
