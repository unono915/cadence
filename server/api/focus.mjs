import { all, get, run, tx } from '../lib/db.mjs';
import { badRequest, notFound } from '../lib/http.mjs';
import { str, int, oneOf, dayString, ts } from '../lib/validate.mjs';
import { dayKey } from '../lib/time.mjs';
import { LIMITS } from '../../web/lib/limits.js';
import { deepBlocks } from './analytics.mjs';

export const SESSION_KINDS = ['focus', 'break'];

/**
 * "완주" 로 쳐 주는 최소 비율.
 *
 * 25분을 계획하고 12초 만에 끈 것도 완주로 기록되고 있었다. 종료 버튼이 상태를 붙이지
 * 않으면 서버가 `done` 을 기본값으로 썼기 때문이다. 그래서 완주율은 언제나 100% 였다 —
 * 항상 1.0 인 숫자는 지표가 아니라 장식이다. 그 값이 Cadence 점수의 한 축이었다.
 *
 * 그렇다고 1초라도 모자라면 중단으로 미는 것도 틀렸다. 24분 50초에 끈 사람은 완주했다.
 * 8할을 기준으로 둔다 — 화면에서 휴식을 권할지 판단할 때 이미 쓰던 값이라, 여기로
 * 옮겨 오면 두 곳이 어긋날 일도 없어진다.
 */
export const DONE_RATIO = 0.8;

/** 이 시각을 넘겨 끝내면 완주로 기록된다. */
function doneAt(row) {
  return row.started_at + Math.round(row.planned_min * 60_000 * DONE_RATIO);
}

const SELECT_SESSION = `
  SELECT s.*, t.title AS task_title, p.name AS project_name, p.color AS project_color
  FROM focus_sessions s
  LEFT JOIN tasks t ON t.id = s.task_id
  LEFT JOIN projects p ON p.id = t.project_id
`;

function shape(row) {
  if (!row) return null;
  const end = row.ended_at ?? Date.now();
  const elapsed = Math.max(0, Math.round((end - row.started_at) / 1000));
  return {
    ...row,
    elapsed_sec: elapsed,
    remaining_sec: row.status === 'running'
      ? Math.max(0, row.planned_min * 60 - elapsed)
      : 0,
    overrun_sec: Math.max(0, elapsed - row.planned_min * 60),
    // 화면이 종료 버튼에 "그만두기 / 마치기" 중 무엇을 쓸지 이걸 보고 정한다.
    // 기준을 화면 쪽에도 적어 두면 언젠가 한쪽만 바뀐다.
    done_at: doneAt(row),
  };
}

export function runningSession() {
  return shape(get(`${SELECT_SESSION} WHERE s.status = 'running' ORDER BY s.started_at DESC LIMIT 1`));
}

/**
 * 세션 구간에 걸친 자동 추적 기록을 해당 태스크에 귀속시킨다.
 * 이미 다른 태스크에 배정된 기록은 건드리지 않는다.
 */
export function attributeActivity(session) {
  if (!session?.task_id) return 0;
  const end = session.ended_at ?? Date.now();
  const res = run(
    `UPDATE activity SET task_id = ?
     WHERE task_id IS NULL AND idle = 0
       AND started_at < ? AND ended_at > ?`,
    session.task_id, end, session.started_at,
  );
  return Number(res.changes || 0);
}

export function startSession(body) {
  const kind = oneOf(body.kind, 'kind', SESSION_KINDS, { optional: true, fallback: 'focus' });
  const planned = int(body.planned_min ?? (kind === 'break' ? 5 : 25), 'planned_min', { min: 1, max: 480 });
  const taskId = int(body.task_id, 'task_id', { optional: true });
  if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) {
    throw badRequest('존재하지 않는 태스크입니다');
  }

  return tx(() => {
    // 진행 중인 세션이 있으면 자동으로 마감한다 — 세션은 항상 최대 하나.
    // 여기서도 채운 시간으로 완주/중단을 가른다. 5분 만에 다른 일로 옮겨 간 것을
    // 완주로 남기면, 세션을 자주 갈아탈수록 완주율이 좋아지는 이상한 지표가 된다.
    const current = get("SELECT * FROM focus_sessions WHERE status = 'running'");
    if (current) {
      finishSessionRow(current, Date.now() >= doneAt(current) ? 'done' : 'abandoned', { auto: true });
    }

    const now = Date.now();
    const res = run(
      `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, status, note, day)
       VALUES (?, ?, ?, ?, 'running', ?, ?)`,
      taskId, kind, planned, now, str(body.note, 'note', { max: LIMITS.SESSION_NOTE }), dayKey(now),
    );
    // 집중 세션을 시작하면 해당 태스크를 '진행 중'으로 옮긴다.
    if (taskId && kind === 'focus') {
      run("UPDATE tasks SET status = 'doing', updated_at = ? WHERE id = ? AND status = 'todo'", now, taskId);
    }
    return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, Number(res.lastInsertRowid)));
  });
}

/**
 * 켜 놓고 잊은 세션인지. 계획한 시간의 세 배를 넘고, 절대 시간으로도 네 시간이 넘은 것.
 * 25분짜리를 한 시간쯤 넘긴 것은 흔한 일이라 여기에 걸리지 않는다.
 */
function isForgotten(row, now) {
  const elapsed = now - row.started_at;
  return elapsed > 4 * 3600_000 && elapsed > row.planned_min * 60_000 * 3;
}

/**
 * @param {boolean} auto 사용자가 직접 끝낸 것이 아니라 새 세션을 시작해서 자동으로 닫히는 경우
 */
function finishSessionRow(row, status, { auto = false } = {}) {
  const now = Date.now();

  // 사흘 전에 켜 둔 세션이 새 세션을 시작하는 순간 "3일짜리 완주"로 남으면
  // 완주율도, 태스크 투입 시간도 통째로 망가진다. 그렇다고 사용자가 직접 누른 종료를
  // 마음대로 잘라서도 안 된다 — 실제로 다섯 시간을 몰입했을 수 있다.
  // 그래서 **자동으로 닫히는 경우에만** 계획한 만큼으로 줄이고 중단으로 남긴다.
  const forgotten = auto && isForgotten(row, now);
  const endedAt = forgotten ? row.started_at + row.planned_min * 60_000 : now;
  const finalStatus = forgotten ? 'abandoned' : status;

  run('UPDATE focus_sessions SET ended_at = ?, status = ? WHERE id = ?', endedAt, finalStatus, row.id);
  attributeActivity({ ...row, ended_at: endedAt });
}

export function endSession(id, body = {}) {
  const row = get('SELECT * FROM focus_sessions WHERE id = ?', id);
  if (!row) throw notFound('세션을 찾을 수 없습니다');
  if (row.status !== 'running') return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, id));

  // 상태를 붙여 보내지 않으면 **얼마나 채웠는지로** 정한다.
  // 예전 기본값은 언제나 'done' 이었고, 그래서 완주율은 늘 100% 였다.
  const status = oneOf(body.status, 'status', ['done', 'abandoned'], {
    optional: true,
    fallback: Date.now() >= doneAt(row) ? 'done' : 'abandoned',
  });
  tx(() => {
    finishSessionRow(row, status);
    if (body.note !== undefined) {
      run('UPDATE focus_sessions SET note = ? WHERE id = ?', str(body.note, 'note', { max: LIMITS.SESSION_NOTE }), id);
    }
  });
  return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, id));
}

export function bumpInterruption(id) {
  const row = get('SELECT * FROM focus_sessions WHERE id = ?', id);
  if (!row) throw notFound('세션을 찾을 수 없습니다');
  run('UPDATE focus_sessions SET interruptions = interruptions + 1 WHERE id = ?', id);
  return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, id));
}

export function updateSession(id, body) {
  const row = get('SELECT * FROM focus_sessions WHERE id = ?', id);
  if (!row) throw notFound('세션을 찾을 수 없습니다');
  const sets = [];
  const params = [];
  if ('note' in body) { sets.push('note = ?'); params.push(str(body.note, 'note', { max: LIMITS.SESSION_NOTE })); }
  if ('task_id' in body) {
    const taskId = int(body.task_id, 'task_id', { optional: true });
    if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) throw badRequest('존재하지 않는 태스크입니다');
    sets.push('task_id = ?');
    params.push(taskId);
  }
  if ('planned_min' in body) {
    sets.push('planned_min = ?');
    params.push(int(body.planned_min, 'planned_min', { min: 1, max: 480 }));
  }
  if (!sets.length) return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, id));
  params.push(id);
  run(`UPDATE focus_sessions SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, id));
}

export function deleteSession(id) {
  if (!get('SELECT id FROM focus_sessions WHERE id = ?', id)) throw notFound('세션을 찾을 수 없습니다');
  run('DELETE FROM focus_sessions WHERE id = ?', id);
  return { deleted: id };
}

/**
 * 세션 없이 몰입한 구간을 찾아 기록을 제안한다.
 *
 * 집중 세션은 "누르는 걸 잊으면" 통째로 비는 데이터다. 실제로는 몰입했는데 기록이 없어
 * 점수와 프로젝트 시간이 실제보다 낮게 나오는 일이 잦다. 자동 추적이 이미 몰입 블록을
 * 알고 있으므로, 방금 끝난(혹은 진행 중인) 블록을 세션으로 남기겠냐고 한 번만 묻는다.
 *
 * 조건: 진행 중인 세션이 없고, 마지막 몰입 블록이 최근까지 이어졌으며,
 *       그 구간이 기존 세션과 겹치지 않을 것.
 */
export function suggestSession({ minSec = 20 * 60, freshnessSec = 300 } = {}) {
  if (runningSession()) return null;

  const day = dayKey();
  const segments = all(`
    SELECT a.app, a.started_at, a.ended_at, a.seconds, a.idle, a.task_id,
           COALESCE(c.kind, 'other') AS kind
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day = ?
    ORDER BY a.started_at ASC
  `, day);
  if (!segments.length) return null;

  const blocks = deepBlocks(segments);
  const last = blocks[blocks.length - 1];
  if (!last) return null;
  if (last.deep_sec < minSec) return null;

  const now = Date.now();
  if (now - last.end > freshnessSec * 1000) return null;

  // 이미 세션으로 기록된 구간이면 제안하지 않는다.
  const overlapping = get(
    `SELECT id FROM focus_sessions
     WHERE started_at < ? AND COALESCE(ended_at, ?) > ?
     LIMIT 1`,
    last.end, now, last.start,
  );
  if (overlapping) return null;

  // 그 구간에 이미 태스크가 붙어 있으면 그것을 기본값으로 제안한다.
  const tally = new Map();
  for (const s of segments) {
    if (!s.task_id || s.idle) continue;
    if (s.started_at >= last.end || s.ended_at <= last.start) continue;
    tally.set(s.task_id, (tally.get(s.task_id) || 0) + s.seconds);
  }
  const taskId = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    start: last.start,
    end: last.end,
    seconds: last.deep_sec,
    minutes: Math.round(last.deep_sec / 60),
    top_app: last.top_app,
    task_id: taskId,
    task_title: taskId ? get('SELECT title FROM tasks WHERE id = ?', taskId)?.title ?? null : null,
  };
}

/** 제안받은 구간을 완료된 세션으로 남긴다. */
export function recordPastSession(body) {
  const start = ts(body.start, 'start');
  const end = ts(body.end, 'end');
  if (end <= start) throw badRequest('end 는 start 보다 커야 합니다');
  if (end - start > 24 * 3600_000) throw badRequest('한 세션은 24시간을 넘을 수 없습니다');
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  const taskId = int(body.task_id, 'task_id', { optional: true });
  if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) throw badRequest('존재하지 않는 태스크입니다');

  // 같은 구간을 두 번 기록하지 않는다. 제안 카드를 두 번 누르거나, 이미 손으로 남긴
  // 구간을 다시 제안받는 경우가 있는데 — 겹친 세션은 몰입 시간을 두 번 세게 만든다.
  const overlap = get(
    `SELECT * FROM focus_sessions
     WHERE started_at < ? AND COALESCE(ended_at, ?) > ? LIMIT 1`,
    end, Date.now(), start,
  );
  if (overlap) return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, overlap.id));

  const res = run(
    `INSERT INTO focus_sessions(task_id, kind, planned_min, started_at, ended_at, status, note, day)
     VALUES (?, 'focus', ?, ?, ?, 'done', ?, ?)`,
    taskId, minutes, start, end,
    str(body.note, 'note', { max: LIMITS.SESSION_NOTE }) || '자동 감지된 몰입 구간',
    dayKey(start),
  );
  const id = Number(res.lastInsertRowid);
  attributeActivity({ task_id: taskId, started_at: start, ended_at: end });
  return shape(get(`${SELECT_SESSION} WHERE s.id = ?`, id));
}

export function listSessions(query = {}) {
  const day = dayString(query.day, 'day', dayKey());
  return all(`${SELECT_SESSION} WHERE s.day = ? ORDER BY s.started_at ASC`, day).map(shape);
}
