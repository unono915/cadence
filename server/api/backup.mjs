import fs from 'node:fs';
import path from 'node:path';
import { db, all, get, run, tx, setting } from '../lib/db.mjs';
import { DB_PATH, DATA_DIR } from '../lib/config.mjs';
import { badRequest } from '../lib/http.mjs';
import { invalidateRules } from '../lib/categorize.mjs';
import { getDayStartHour, dayKey } from '../lib/time.mjs';
import { tracker } from '../tracker/tracker.mjs';

/**
 * 시작 시각으로부터 업무일 키를 SQL 안에서 계산한다 (`?` 는 업무일 시작 시각).
 *
 * `time.mjs` 의 `dayKey()` 와 **같은 규칙이어야 한다.** 어긋나면 무결성 점검이 멀쩡한 행을
 * "날짜가 틀렸다" 고 잡고, 고치기가 자바스크립트 쪽 값으로 바꿔 놓고, 다음 점검이 다시
 * 틀렸다고 잡는다 — 아무리 눌러도 사라지지 않는 경고가 된다.
 *
 * 그래서 **벽시계 기준**으로 센다: 로컬 시각으로 옮긴 **뒤에** 시작 시각만큼 뺀다.
 * 예전에는 epoch 에서 먼저 빼고 로컬로 옮겼는데, 그건 서머타임 전환일에 한 시간 어긋난다
 * (`dayKey()` 주석 참고). 서머타임이 없는 곳에서는 두 방식의 결과가 같아서 드러나지 않았다.
 *
 * 전체 행을 자바스크립트로 끌어오지 않으려고 SQL 로 센다 — 설정 화면을 열 때마다
 * 수만 행을 메모리에 올릴 수는 없기 때문.
 */
const DAY_EXPR = "strftime('%Y-%m-%d', started_at / 1000, 'unixepoch', 'localtime', printf('-%d hours', ?))";

/**
 * 시작 시각과 내용이 완전히 같은 중복 기록.
 *
 * 예전 판에서는 서버를 다시 켤 때마다 진행 중이던 자리비움 구간이 새 행으로 또 쌓였다.
 * 지금은 이어받도록 고쳤지만, 이미 생긴 것은 정리해 주어야 합계가 맞는다.
 * "완전히 겹치는 행"을 자기 조인으로 찾으면 수만 행에서 몇 분이 걸리므로,
 * 이 버그가 만드는 모양(같은 시작 시각 + 같은 내용)만 집계로 잡는다.
 *
 * 다만 **시작 시각이 밀리초까지 같은 경우만** 잡는다. 실제로 쌓인 중복은 소급 시점의
 * 흔들림 때문에 2~130ms 씩 어긋나 있어서 여기에 걸리지 않았다 — 그쪽은 아래 '겹침' 점검이
 * 시각을 실제로 비교해 잡아낸다. 이 항목은 정확히 일치하는 옛 기록을 위한 것이다.
 */
const TRACKER_ROWS = "exe NOT IN ('manual', 'resolved')";

const DUPLICATE_GROUPS_SQL = `
  SELECT started_at, app, title, idle, MIN(id) AS keep_id, COUNT(*) AS n
  FROM activity
  WHERE ${TRACKER_ROWS}
  GROUP BY started_at, app, title, idle
  HAVING COUNT(*) > 1
`;

const DUPLICATE_COUNT_SQL = `SELECT COALESCE(SUM(n - 1), 0) AS dupes FROM (${DUPLICATE_GROUPS_SQL})`;

/**
 * 백업 가져오기.
 *
 * 내보내기가 있으면 가져오기도 있어야 한다 — 그래야 데이터가 정말 사용자 것이 된다.
 * 덮어쓰기 전에 DB 파일을 통째로 복사해 두고, 실패하면 아무것도 바꾸지 않는다.
 */

/**
 * 숫자여야만 하는 열.
 *
 * SQLite 는 타입이 느슨해서 INTEGER 열에 문자열을 넣어도 그대로 받는다. 그러면 가져오기는
 * 조용히 성공하고, 그 뒤로 시각 계산이 전부 NaN 이 된다 — 히트맵이 비고, 합계가 사라지고,
 * 어디서부터 잘못됐는지 알 수 없다. 들어올 때 막는 편이 훨씬 싸다.
 */
const NUMERIC_COLUMNS = new Set([
  'id', 'project_id', 'task_id', 'category_id', 'sort_order', 'archived', 'is_regex', 'priority',
  'importance', 'urgency', 'estimate_min', 'planned_min', 'interruptions', 'seconds', 'idle',
  'reviewed', 'weekly_target_min', 'pinned',
  'created_at', 'updated_at', 'completed_at', 'due_at', 'started_at', 'ended_at',
]);

export const BACKUP_TABLES = [
  // 순서가 중요하다: 참조되는 쪽을 먼저 넣는다.
  { name: 'categories', columns: ['id', 'name', 'kind', 'color', 'sort_order'] },
  {
    name: 'projects',
    columns: ['id', 'name', 'color', 'archived', 'created_at', 'sort_order', 'weekly_target_min'],
  },
  {
    name: 'tasks',
    columns: ['id', 'project_id', 'title', 'notes', 'status', 'importance', 'urgency',
      'estimate_min', 'due_at', 'created_at', 'updated_at', 'completed_at', 'sort_order', 'planned_for'],
  },
  {
    name: 'rules',
    columns: ['id', 'field', 'pattern', 'is_regex', 'category_id', 'priority', 'created_at'],
  },
  {
    name: 'focus_sessions',
    columns: ['id', 'task_id', 'kind', 'planned_min', 'started_at', 'ended_at', 'status',
      'interruptions', 'note', 'day'],
  },
  {
    name: 'activity',
    columns: ['id', 'app', 'title', 'exe', 'started_at', 'ended_at', 'seconds', 'idle',
      'category_id', 'task_id', 'day', 'reviewed', 'pinned'],
  },
  { name: 'notes', columns: ['day', 'body', 'updated_at'] },
  { name: 'settings', columns: ['key', 'value'] },
];

/**
 * 우리가 만든 사본의 이름 모양.
 *
 * `cadence-backup-*.db` 처럼 헐겁게 잡으면, 사용자가 같은 폴더에 손으로 넣어 둔
 * `cadence-backup-중요.db` 도 우리 것으로 세어 **정리 대상이 된다** (최근 5개만 남기므로).
 * 남의 파일을 지우는 것은 되돌릴 수 없는 일이라 한 번의 실수로 끝난다.
 * 그래서 우리가 찍는 시각 모양 그대로만 센다.
 */
const SNAPSHOT_RE = /^cadence-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;

/** 가져오기 직전에 남기는 안전 사본. 경로를 돌려준다. */
export function snapshotDatabase() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(DATA_DIR, `cadence-backup-${stamp}.db`);
  // WAL 내용까지 파일에 반영한 뒤 복사한다.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  fs.copyFileSync(DB_PATH, target);
  pruneSnapshots();
  return target;
}

/** 남아 있는 사본들을 최신 순으로. */
function snapshotFiles() {
  try {
    return fs.readdirSync(DATA_DIR)
      .filter((f) => SNAPSHOT_RE.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(DATA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return [];
  }
}

/** 자동 사본이 무한정 쌓이지 않도록 최근 5개만 남긴다. */
function pruneSnapshots() {
  for (const { f } of snapshotFiles().slice(5)) {
    try { fs.unlinkSync(path.join(DATA_DIR, f)); } catch { /* 지우지 못해도 치명적이지 않다 */ }
  }
}

/**
 * 하루에 한 번 사본을 남긴다.
 *
 * 지금까지는 가져오기·정리 직전에만 사본을 만들었다. 하지만 데이터가 사라지는 흔한 경로는
 * 그런 조작이 아니라 실수로 지우거나 파일이 깨지는 쪽이다. 하루치 사본이 있으면
 * 최악이라도 하루만 잃는다.
 *
 * 사본은 DB 와 같은 폴더에 둔다 — 디스크 자체가 죽으면 함께 사라지므로,
 * 진짜 백업은 설정의 '전체 백업 (JSON)' 으로 밖에 내보내야 한다. README 에도 적어 둔다.
 */
export function autoSnapshot({ maxAgeMs = 24 * 3600_000 } = {}) {
  const newest = snapshotFiles()[0];
  // 나이가 **음수**면 사본이 미래 시각을 달고 있다는 뜻이다. 시계가 뒤로 간 것이다 —
  // 서머타임, NTP 보정, 시각이 틀린 채 쓰던 노트북, 다른 PC 에서 옮겨 온 폴더.
  // 그냥 `age < maxAgeMs` 로 두면 음수는 언제나 참이라 **자동 사본이 영영 멈춘다.**
  // 아무 오류도 나지 않고 화면에도 표시되지 않으므로, 백업이 없다는 사실은
  // 정작 필요한 순간에야 드러난다. 미래 사본은 낡은 것으로 본다.
  const age = newest ? Date.now() - newest.t : Infinity;
  if (newest && age >= 0 && age < maxAgeMs) {
    return { created: false, newest: newest.f };
  }
  try {
    return { created: true, path: snapshotDatabase() };
  } catch (err) {
    // 사본을 못 남겨도 서버는 계속 돌아야 한다.
    return { created: false, error: err.message };
  }
}

/** 기동 시 한 번, 이후 여섯 시간마다 확인한다 (하루를 넘긴 것만 실제로 남긴다). */
export function startAutoSnapshot({ intervalMs = 6 * 3600_000 } = {}) {
  autoSnapshot();
  const timer = setInterval(() => autoSnapshot(), intervalMs);
  timer.unref?.();
  return timer;
}

function rowsOf(payload, table) {
  const rows = payload[table];
  if (rows === undefined) return [];
  if (!Array.isArray(rows)) throw badRequest(`${table}: 배열이어야 합니다`);
  return rows;
}

/**
 * 백업에 없는 칸을 무엇으로 채울지 스키마에서 읽어 온다.
 *
 * 지난 판에서 만든 백업에는 그 뒤에 생긴 열이 없다. 없는 값을 그냥 NULL 로 넣으면
 * `NOT NULL` 열에서 제약 위반이 나고 **가져오기 전체가 실패**한다 — 실제로 `pinned` 열을
 * 더하자마자 그 전에 만든 백업이 하나도 복원되지 않았다. 백업의 값어치는 "옛것도 열린다"
 * 는 데 있으므로, 이건 백업 기능이 조용히 망가진 것과 같다.
 *
 * 열마다 기본값을 손으로 적어 두면 다음 열을 더할 때 또 잊는다. 스키마에 이미 적혀 있으니
 * 거기서 읽는다.
 */
const columnFallbacks = new Map();
function fallbackFor(table, column) {
  if (!columnFallbacks.has(table)) {
    const map = new Map();
    for (const col of db.prepare(`PRAGMA table_info(${table})`).all()) {
      if (!col.notnull) continue;
      // dflt_value 는 SQL 리터럴이다("0", "''"). 우리 스키마에는 숫자와 빈 문자열뿐이다.
      const raw = col.dflt_value;
      if (raw === null || raw === undefined) continue;
      const text = String(raw).trim();
      map.set(col.name, /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text.replace(/^'(.*)'$/, '$1'));
    }
    columnFallbacks.set(table, map);
  }
  const map = columnFallbacks.get(table);
  return map.has(column) ? map.get(column) : null;
}

/**
 * @param {object} payload  export/all.json 과 같은 모양
 * @param {'replace'|'merge'} mode
 *   replace — 기존 데이터를 모두 지우고 백업으로 대체
 *   merge   — 같은 id 가 있으면 건너뛰고 없는 것만 추가
 */
export function importBackup(payload, mode = 'replace') {
  if (!payload || typeof payload !== 'object') throw badRequest('백업 데이터가 필요합니다');
  if (!['replace', 'merge'].includes(mode)) throw badRequest("mode: 'replace' 또는 'merge'");

  const known = BACKUP_TABLES.map((t) => t.name);
  if (!known.some((t) => Array.isArray(payload[t]))) {
    throw badRequest('Cadence 백업 파일이 아닙니다 (알려진 테이블이 없습니다)');
  }

  const snapshot = snapshotDatabase();
  const counts = {};
  let skipped = 0;

  try {
    tx(() => {
      db.exec('PRAGMA defer_foreign_keys = ON');

      if (mode === 'replace') {
        // 참조하는 쪽부터 지운다.
        for (const t of [...BACKUP_TABLES].reverse()) run(`DELETE FROM ${t.name}`);
      }

      for (const table of BACKUP_TABLES) {
        const rows = rowsOf(payload, table.name);
        const cols = table.columns;
        const placeholders = cols.map(() => '?').join(', ');
        const verb = mode === 'merge' ? 'INSERT OR IGNORE' : 'INSERT';
        const sql = `${verb} INTO ${table.name}(${cols.join(', ')}) VALUES (${placeholders})`;
        let n = 0;
        for (const row of rows) {
          if (!row || typeof row !== 'object') continue;

          // 숫자여야 할 자리에 문자열이 들어오면 여기서 멈춘다. 롤백되므로 기존 데이터는 그대로다.
          for (const col of cols) {
            if (!NUMERIC_COLUMNS.has(col)) continue;
            const value = row[col];
            if (value === undefined || value === null) continue;
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              throw badRequest(
                `${table.name}.${col}: 숫자여야 합니다`,
                `받은 값: ${JSON.stringify(value)?.slice(0, 60)}`,
              );
            }
          }
          // 시도한 횟수가 아니라 **실제로 들어간 행 수**를 센다.
          // 합치기는 같은 id 가 있으면 조용히 건너뛰므로, 시도를 세면 한 건도 안 들어간
          // 가져오기가 "15만 건 복원 완료"로 보고된다.
          const res = run(sql, ...cols.map((c) => (
            row[c] === undefined ? fallbackFor(table.name, c) : row[c]
          )));
          if (Number(res.changes)) n++;
          else skipped++;
        }
        counts[table.name] = n;
      }
    });
  } catch (err) {
    throw badRequest(`가져오기 실패 — 데이터가 바뀌지 않았습니다: ${err.message}`, `사본: ${snapshot}`);
  }

  invalidateRules();
  tracker.releaseOpenSegment();
  return { mode, counts, skipped, snapshot };
}

/**
 * 오래된 활동 기록 정리.
 * 기록이 쌓이면 DB 가 커지고 조회가 느려진다. 태스크·세션·노트는 건드리지 않는다.
 */
export function pruneActivity(beforeDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(beforeDay || '')) throw badRequest('beforeDay: YYYY-MM-DD 형식이 필요합니다');
  const doomed = all('SELECT COUNT(*) AS n FROM activity WHERE day < ?', beforeDay)[0].n;
  if (!doomed) return { deleted: 0, snapshot: null };
  const snapshot = snapshotDatabase();
  run('DELETE FROM activity WHERE day < ?', beforeDay);
  db.exec('VACUUM');
  tracker.releaseOpenSegment();
  return { deleted: doomed, snapshot };
}

/**
 * 이미 기록된 창 제목을 모두 지운다.
 *
 * '창 제목 수집' 을 끄면 **그 뒤로** 제목을 남기지 않는다. 그런데 끄는 사람이 원하는 것은
 * 대개 그게 아니다 — 문서 이름이나 거래처 이름이 창 제목으로 남아 있다는 걸 뒤늦게
 * 깨닫고 끄는 것이라, 지우고 싶은 건 **이미 쌓인 쪽**이다. 그걸 없앨 방법이 화면 어디에도
 * 없으면 남은 길은 데이터베이스 파일을 통째로 버리는 것뿐인데, 그러면 몇 달치 기록을
 * 함께 잃는다. 이 도구는 "이 PC 밖으로 나가지 않는다" 를 내세우면서, 정작 안에 남은 것을
 * 지울 방법은 주지 않고 있었다.
 *
 * 활동 기록의 행은 그대로 두고 제목만 비운다 — 시간·앱·분류는 남으므로 지금까지의
 * 숫자는 하나도 달라지지 않는다. 되돌릴 수 없는 일이라 먼저 사본을 남긴다.
 */
export function forgetTitles() {
  const n = get("SELECT COUNT(*) AS n FROM activity WHERE title <> ''").n;
  if (!n) return { cleared: 0, snapshot: null };
  const snapshot = snapshotDatabase();
  run("UPDATE activity SET title = '' WHERE title <> ''");
  // 추적기가 들고 있는 진행 중 구간에는 아직 제목이 남아 있다. 놓아 주지 않으면
  // 다음 기록에서 그 제목이 도로 쓰인다 — 지웠는데 잠시 뒤 되살아나는 셈이다.
  tracker.releaseOpenSegment();
  return { cleared: n, snapshot };
}

/**
 * 데이터 무결성 점검.
 *
 * 추적기는 프로세스가 갑자기 죽어도 기록이 남도록 "먼저 쓰고 나중에 고치는" 방식이라,
 * 드물게 어중간한 행이 남을 수 있다. 무엇이 이상한지 먼저 보여 주고, 고치는 것은
 * 사용자가 누를 때만 한다 — 조용히 데이터를 건드리지 않기 위해.
 */
export function integrityCheck() {
  const issues = [];
  const add = (key, label, count, fixable, detail) => {
    if (count > 0) issues.push({ key, label, count, fixable, detail });
  };

  add('reversed', '끝 시각이 시작보다 이른 기록',
    get('SELECT COUNT(*) AS n FROM activity WHERE ended_at < started_at').n,
    true, '삭제합니다 — 끝이 시작보다 이른 구간에는 쓸 수 있는 시간 정보가 없습니다.');

  add('seconds_mismatch', '길이가 시각과 맞지 않는 기록',
    get(`SELECT COUNT(*) AS n FROM activity
         WHERE ABS(seconds - (ended_at - started_at) / 1000) > 2`).n,
    true, '시작·끝 시각으로 길이를 다시 계산합니다.');

  add('zero_length', '길이가 0인 활동 기록',
    get('SELECT COUNT(*) AS n FROM activity WHERE idle = 0 AND seconds = 0').n,
    true, '삭제합니다 — 기록이 열리자마자 프로세스가 끊긴 흔적입니다.');

  add('orphan_day', '날짜 표기가 시각과 어긋난 기록',
    get(`SELECT COUNT(*) AS n FROM activity WHERE day != ${DAY_EXPR}`, getDayStartHour()).n,
    true, '업무일 시작 시각 설정을 바꾼 뒤에 생깁니다. 시각 기준으로 다시 계산합니다.');

  add('duplicate', '내용과 시작 시각이 똑같은 중복 기록',
    get(DUPLICATE_COUNT_SQL).dupes,
    true, '가장 먼저 기록된 하나만 남기고 지웁니다 — 서버를 여러 번 켰을 때 생길 수 있습니다.');

  add('bad_types', '시각이 숫자가 아닌 기록',
    get(`SELECT COUNT(*) AS n FROM activity
         WHERE typeof(started_at) NOT IN ('integer', 'real')
            OR typeof(ended_at) NOT IN ('integer', 'real')
            OR typeof(seconds) NOT IN ('integer', 'real')`).n,
    true, '삭제합니다 — 시각을 읽을 수 없으면 어느 지표에도 쓸 수 없고, 계산을 통째로 망가뜨립니다.');

  add('overlap', '시간이 겹치는 활동 기록',
    all(OVERLAP_ROWS_SQL).length,
    true, '같은 시각이 두 번 세어져 하루가 실제보다 길어집니다. 손으로 넣은 기록을 남기고, 나머지는 앞선 기록이 끝난 뒤로 밀어 겹친 부분만 덜어 냅니다.');

  add('session_overlap', '시간이 겹치는 집중 세션',
    all(SESSION_OVERLAP_SQL).length,
    true, '세션은 한 번에 하나만 열립니다. 겹치면 태스크 투입 시간이 두 번 세어집니다 — 뒤엣것을 앞선 세션이 끝난 뒤로 밉니다.');

  add('running_stale', '하루 넘게 진행 중인 집중 세션',
    get(
      "SELECT COUNT(*) AS n FROM focus_sessions WHERE status = 'running' AND started_at < ?",
      Date.now() - 86_400_000,
    ).n,
    true, '종료를 누르지 않고 창을 닫은 경우입니다. 계획한 시간만큼만 인정하고 마감합니다.');

  return { ok: issues.length === 0, issues, checked_at: Date.now() };
}

/**
 * 시간이 겹치는 기록.
 *
 * 집계는 seconds 를 그냥 더한다. 두 기록이 같은 시각을 덮고 있으면 그만큼 하루가 늘어나고,
 * 활동·몰입·카테고리 배분이 전부 조금씩 부풀어 오른다 — 숫자는 멀쩡해 보인다.
 *
 * 지금은 수동 입력이 겹치는 구간을 대신하므로 새로 생기지 않지만,
 * 그 전에 쌓였거나 백업으로 들어온 기록에는 남아 있을 수 있다.
 *
 * 시간 순으로 이웃한 것만 본다. 창 하나가 다른 창 여럿을 통째로 감싸는 경우까지 잡으려면
 * 자기 조인이 필요한데, 15만 행에서 그 비용은 점검 한 번에 감당할 값이 아니다.
 * 실제로 문제가 되는 겹침은 거의 전부 이웃끼리다.
 */
const OVERLAP_ROWS_SQL = `
  SELECT id, prev_id, started_at, prev_end FROM (
    SELECT id, started_at,
           LAG(id) OVER (ORDER BY started_at, id) AS prev_id,
           LAG(ended_at) OVER (ORDER BY started_at, id) AS prev_end
    FROM activity
  )
  WHERE prev_end IS NOT NULL AND started_at < prev_end
`;

/**
 * 시간이 겹치는 집중 세션.
 *
 * 이 앱은 세션을 한 번에 하나만 연다(새로 시작하면 앞의 것이 닫힌다). 그러니 겹친 세션은
 * 밖에서 들어온 것이다 — 손상된 백업을 가져왔거나, 데이터를 직접 손댔거나.
 * 겹치면 태스크 투입 시간이 두 번 세어지는데, 화면에는 그냥 "많이 했다" 로 보인다.
 */
const SESSION_OVERLAP_SQL = `
  SELECT id, prev_id FROM (
    SELECT id, started_at,
           LAG(id) OVER (ORDER BY started_at, id) AS prev_id,
           LAG(COALESCE(ended_at, started_at)) OVER (ORDER BY started_at, id) AS prev_end
    FROM focus_sessions
  )
  WHERE prev_end IS NOT NULL AND started_at < prev_end
`;

/** 점검에서 나온 문제를 고친다. 고치기 전에 사본을 남긴다. */
export function repairIntegrity() {
  const before = integrityCheck();
  if (before.ok) return { repaired: {}, snapshot: null, ...integrityCheck() };

  const snapshot = snapshotDatabase();
  const repaired = {};

  tx(() => {
    // 순서 주의: 길이 0 정리보다 먼저 지운다. 뒤집힌 구간을 "길이 0" 으로 고쳐 두면
    // 어느 쪽 항목으로 세어졌는지가 헷갈린다.
    repaired.reversed = Number(run(
      'DELETE FROM activity WHERE ended_at < started_at',
    ).changes || 0);

    repaired.zero_length = Number(run(
      'DELETE FROM activity WHERE idle = 0 AND seconds = 0',
    ).changes || 0);

    // 시각을 읽을 수 없는 행은 어느 지표에도 쓸 수 없다. 남겨 두면 계산만 망가진다.
    repaired.bad_types = Number(run(
      `DELETE FROM activity
       WHERE typeof(started_at) NOT IN ('integer', 'real')
          OR typeof(ended_at) NOT IN ('integer', 'real')
          OR typeof(seconds) NOT IN ('integer', 'real')`,
    ).changes || 0);

    repaired.seconds_mismatch = Number(run(`
      UPDATE activity SET seconds = CAST((ended_at - started_at) / 1000 AS INTEGER)
      WHERE ABS(seconds - (ended_at - started_at) / 1000) > 2
    `).changes || 0);

    // 중복은 가장 먼저 기록된 행만 남긴다. 남는 행의 끝 시각은 그룹에서 가장 늦은 값으로
    // 늘려, 실제로 흐른 시간이 짧아지지 않게 한다.
    let dupes = 0;
    for (const g of all(DUPLICATE_GROUPS_SQL)) {
      const widest = get(
        `SELECT MAX(ended_at) AS ended_at FROM activity
         WHERE started_at = ? AND app = ? AND title = ? AND idle = ? AND ${TRACKER_ROWS}`,
        g.started_at, g.app, g.title, g.idle,
      ).ended_at;
      run(
        'UPDATE activity SET ended_at = ?, seconds = CAST((? - started_at) / 1000 AS INTEGER) WHERE id = ?',
        widest, widest, g.keep_id,
      );
      dupes += Number(run(
        `DELETE FROM activity
         WHERE started_at = ? AND app = ? AND title = ? AND idle = ? AND id != ? AND ${TRACKER_ROWS}`,
        g.started_at, g.app, g.title, g.idle, g.keep_id,
      ).changes || 0);
    }
    repaired.duplicate = dupes;

    // 겹침 없애기 — 두 단계로 한다.
    //
    // 처음에는 "겹친 두 줄 중 진 쪽을 옮긴다" 를 되풀이했는데, 한 줄을 옮기면 그 옆줄과
    // 새로 겹치는 일이 생겨서 15만 행에서 9만 번을 고치고도 끝나지 않았다.
    // 순서를 정해 한 번만 훑으면 반드시 끝난다.
    //
    //  1단계 — 손으로 넣은 기록이 이긴다. "이 시간에는 회의였다" 는 사용자의 단언이고,
    //          그 시간대의 자동 기록은 창을 열어 둔 채 자리를 비운 흔적일 뿐이다.
    //          수동 기록은 몇 건뿐이라 하나씩 훑어도 싸다.
    //  2단계 — 남은 것을 시각 순으로 한 번 훑으며, 앞줄이 끝난 지점부터 시작하도록 뒤를 민다.
    //          앞으로만 나아가므로 새 겹침이 생기지 않고, 잘려 나가는 것은 겹친 부분뿐이다.
    let overlaps = 0;

    const dropOrTrim = (row, start, end) => {
      const seconds = Math.round((end - start) / 1000);
      if (seconds < 1) {
        run('DELETE FROM activity WHERE id = ?', row.id);
      } else {
        run(
          'UPDATE activity SET started_at = ?, ended_at = ?, seconds = ? WHERE id = ?',
          start, end, seconds, row.id,
        );
      }
      overlaps++;
    };

    for (const manual of all("SELECT * FROM activity WHERE exe = 'manual' ORDER BY started_at")) {
      const hits = all(
        `SELECT * FROM activity
         WHERE id != ? AND exe != 'manual' AND started_at < ? AND ended_at > ?`,
        manual.id, manual.ended_at, manual.started_at,
      );
      for (const row of hits) {
        if (row.started_at >= manual.started_at && row.ended_at <= manual.ended_at) {
          run('DELETE FROM activity WHERE id = ?', row.id);
          overlaps++;
        } else if (row.started_at < manual.started_at) {
          dropOrTrim(row, row.started_at, manual.started_at);
        } else {
          dropOrTrim(row, manual.ended_at, row.ended_at);
        }
      }
    }

    let cursor = -Infinity;
    for (const row of all('SELECT id, started_at, ended_at FROM activity ORDER BY started_at, id')) {
      if (row.started_at >= cursor) {
        cursor = row.ended_at;
        continue;
      }
      if (row.ended_at <= cursor) {
        // 앞선 기록에 통째로 덮였다 — 남길 것이 없다.
        run('DELETE FROM activity WHERE id = ?', row.id);
        overlaps++;
        continue;
      }
      dropOrTrim(row, cursor, row.ended_at);
      cursor = row.ended_at;
    }
    repaired.overlap = overlaps;

    // 세션도 같은 방식으로 — 시각 순 한 번 훑기. 진행 중인 세션(ended_at 이 없는 것)은
    // 아직 끝나지 않았으므로 건드리지 않는다.
    let sessionOverlaps = 0;
    let sessionCursor = -Infinity;
    for (const row of all('SELECT id, started_at, ended_at FROM focus_sessions ORDER BY started_at, id')) {
      if (row.ended_at === null) continue;
      if (row.started_at >= sessionCursor) {
        sessionCursor = row.ended_at;
        continue;
      }
      if (row.ended_at <= sessionCursor) {
        run('DELETE FROM focus_sessions WHERE id = ?', row.id);
      } else {
        run(
          'UPDATE focus_sessions SET started_at = ?, day = ? WHERE id = ?',
          sessionCursor, dayKey(sessionCursor), row.id,
        );
        sessionCursor = row.ended_at;
      }
      sessionOverlaps++;
    }
    repaired.session_overlap = sessionOverlaps;

    const hour = getDayStartHour();
    repaired.orphan_day = Number(run(
      `UPDATE activity SET day = ${DAY_EXPR} WHERE day != ${DAY_EXPR}`,
      hour, hour,
    ).changes || 0);

    // 오래 열려 있는 세션은 계획한 시간만큼만 인정한다 —
    // 창을 닫은 채 하루가 지난 것을 "12시간 집중"으로 세면 모든 지표가 망가진다.
    let sessionFixes = 0;
    for (const s of all(
      "SELECT id, started_at, planned_min FROM focus_sessions WHERE status = 'running' AND started_at < ?",
      Date.now() - 86_400_000,
    )) {
      run(
        "UPDATE focus_sessions SET ended_at = ?, status = 'abandoned' WHERE id = ?",
        s.started_at + s.planned_min * 60_000, s.id,
      );
      sessionFixes++;
    }
    repaired.running_stale = sessionFixes;
  });

  tracker.releaseOpenSegment();
  return { repaired, snapshot, ...integrityCheck() };
}

/** 데이터 규모 요약 — 설정 화면에서 "얼마나 쌓였나"를 보여주기 위한 것. */
export function storageStats() {
  const size = (() => {
    try { return fs.statSync(DB_PATH).size; } catch { return 0; }
  })();
  const row = (sql) => all(sql)[0];
  const lastExport = Number(setting('last_export_at', 0)) || null;
  return {
    db_path: DB_PATH,
    db_bytes: size,
    // 자동 사본은 같은 디스크에 있다. 디스크가 죽으면 함께 사라지므로,
    // 진짜 백업(전체 백업 JSON)을 마지막으로 챙긴 시각을 함께 알려 준다.
    last_export_at: lastExport,
    activity: row('SELECT COUNT(*) AS n, MIN(day) AS first_day, MAX(day) AS last_day FROM activity'),
    // 창 제목이 남아 있는 기록의 수. 지울 것이 없는데 지우기 단추를 내밀면
    // 눌러 본 사람만 "0건" 을 보게 된다.
    titled: row("SELECT COUNT(*) AS n FROM activity WHERE title <> ''").n,
    sessions: row('SELECT COUNT(*) AS n FROM focus_sessions'),
    tasks: row('SELECT COUNT(*) AS n FROM tasks'),
    notes: row('SELECT COUNT(*) AS n FROM notes'),
    snapshots: fs.readdirSync(DATA_DIR)
      .filter((f) => SNAPSHOT_RE.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(DATA_DIR, f));
        return { file: f, bytes: st.size, at: st.mtimeMs };
      })
      .sort((a, b) => b.at - a.at),
  };
}
