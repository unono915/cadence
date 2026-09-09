import { all, get, run, tx } from '../lib/db.mjs';
import { badRequest, notFound } from '../lib/http.mjs';
import { str, int, oneOf, color, dayString, ts } from '../lib/validate.mjs';
import { LIMITS } from '../../web/lib/limits.js';

export const STATUSES = ['todo', 'doing', 'done', 'archived'];

/**
 * 태스크에 실제로 들어간 시간.
 *  - focus_sec  : 집중 세션으로 기록된 시간 (진행 중인 세션은 현재 시각까지)
 *  - tracked_sec: 태스크에 연결됐지만 세션 구간과 겹치지 않는 자동 추적 시간
 * 두 값을 더해도 중복 계산되지 않도록 겹침을 배제한다.
 */
const TIME_COLUMNS = `
  (SELECT COALESCE(SUM(
      (CASE WHEN s.ended_at IS NULL THEN unixepoch() * 1000 ELSE s.ended_at END) - s.started_at
   ) / 1000, 0)
   FROM focus_sessions s
   WHERE s.task_id = t.id AND s.kind = 'focus' AND s.status != 'abandoned') AS focus_sec,

  (SELECT COALESCE(SUM(a.seconds), 0)
   FROM activity a
   WHERE a.task_id = t.id AND a.idle = 0
     AND NOT EXISTS (
       SELECT 1 FROM focus_sessions s2
       WHERE s2.task_id = a.task_id
         AND a.started_at < COALESCE(s2.ended_at, 9007199254740991)
         AND a.ended_at   > s2.started_at
     )) AS tracked_sec
`;

const SELECT_TASK = `
  SELECT t.*, p.name AS project_name, p.color AS project_color,
    ${TIME_COLUMNS}
  FROM tasks t
  LEFT JOIN projects p ON p.id = t.project_id
`;

function shape(row) {
  if (!row) return row;
  const actual = (row.focus_sec || 0) + (row.tracked_sec || 0);
  return {
    ...row,
    focus_sec: row.focus_sec || 0,
    tracked_sec: row.tracked_sec || 0,
    actual_sec: actual,
    actual_min: Math.round(actual / 60),
    quadrant: quadrantOf(row.importance, row.urgency),
    accuracy:
      row.estimate_min && actual > 0
        ? Number((actual / 60 / row.estimate_min).toFixed(2))
        : null,
  };
}

/** 아이젠하워 사분면: 1=중요+긴급, 2=중요, 3=긴급, 4=나머지 */
export function quadrantOf(importance, urgency) {
  const imp = importance >= 2;
  const urg = urgency >= 2;
  if (imp && urg) return 1;
  if (imp) return 2;
  if (urg) return 3;
  return 4;
}

function nextSort(status) {
  const row = get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE status = ?', status);
  return (row?.m || 0) + 1000;
}

export function listTasks(query = {}) {
  const where = [];
  const params = [];

  if (query.status) {
    const statuses = String(query.status).split(',').map((s) => s.trim()).filter(Boolean);
    for (const s of statuses) oneOf(s, 'status', STATUSES);
    where.push(`t.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  } else {
    where.push("t.status != 'archived'");
  }

  if (query.project_id) {
    where.push('t.project_id = ?');
    params.push(int(query.project_id, 'project_id'));
  }
  if (query.planned_for) {
    where.push('t.planned_for = ?');
    params.push(dayString(query.planned_for, 'planned_for'));
  }
  if (query.q) {
    where.push('(t.title LIKE ? OR t.notes LIKE ?)');
    const like = `%${String(query.q).slice(0, 100)}%`;
    params.push(like, like);
  }

  const sql = `${SELECT_TASK} WHERE ${where.join(' AND ')}
    ORDER BY
      CASE t.status WHEN 'doing' THEN 0 WHEN 'todo' THEN 1 WHEN 'done' THEN 2 ELSE 3 END,
      t.sort_order ASC, t.id DESC
    LIMIT 500`;
  return all(sql, ...params).map(shape);
}

export function getTask(id) {
  const row = get(`${SELECT_TASK} WHERE t.id = ?`, id);
  if (!row) throw notFound('태스크를 찾을 수 없습니다');
  return shape(row);
}

export function createTask(body) {
  const now = Date.now();
  const title = str(body.title, 'title', { min: 1, max: LIMITS.TASK_TITLE });
  const projectId = int(body.project_id, 'project_id', { optional: true });
  if (projectId && !get('SELECT id FROM projects WHERE id = ?', projectId)) {
    throw badRequest('존재하지 않는 프로젝트입니다');
  }
  const status = oneOf(body.status, 'status', STATUSES, { optional: true, fallback: 'todo' });
  const res = run(
    `INSERT INTO tasks(project_id, title, notes, status, importance, urgency, estimate_min, due_at, created_at, updated_at, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId,
    title,
    str(body.notes, 'notes', { max: LIMITS.TASK_NOTES }),
    status,
    int(body.importance ?? 1, 'importance', { min: 0, max: 2 }),
    int(body.urgency ?? 1, 'urgency', { min: 0, max: 2 }),
    int(body.estimate_min, 'estimate_min', { min: 1, max: 6000, optional: true }),
    ts(body.due_at, 'due_at', { optional: true }),
    now,
    now,
    nextSort(status),
  );
  return getTask(Number(res.lastInsertRowid));
}

const PATCHABLE = {
  title: (v) => str(v, 'title', { min: 1, max: LIMITS.TASK_TITLE }),
  notes: (v) => str(v, 'notes', { max: LIMITS.TASK_NOTES }),
  status: (v) => oneOf(v, 'status', STATUSES),
  importance: (v) => int(v, 'importance', { min: 0, max: 2 }),
  urgency: (v) => int(v, 'urgency', { min: 0, max: 2 }),
  estimate_min: (v) => int(v, 'estimate_min', { min: 1, max: 6000, optional: true }),
  due_at: (v) => ts(v, 'due_at', { optional: true }),
  project_id: (v) => int(v, 'project_id', { optional: true }),
  sort_order: (v) => int(v, 'sort_order', { min: 0, max: 10_000_000 }),
  planned_for: (v) => (v === null || v === '' ? null : dayString(v, 'planned_for')),
};

export function updateTask(id, body) {
  const existing = get('SELECT * FROM tasks WHERE id = ?', id);
  if (!existing) throw notFound('태스크를 찾을 수 없습니다');

  const sets = [];
  const params = [];
  for (const [key, parse] of Object.entries(PATCHABLE)) {
    if (!(key in body)) continue;
    sets.push(`${key} = ?`);
    params.push(parse(body[key]));
  }
  if (!sets.length) return getTask(id);

  // 완료 시각은 상태 전이에 따라 자동 관리한다.
  if ('status' in body) {
    if (body.status === 'done' && existing.status !== 'done') {
      sets.push('completed_at = ?');
      params.push(Date.now());
    } else if (body.status !== 'done' && existing.status === 'done') {
      sets.push('completed_at = NULL');
    }
  }
  sets.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getTask(id);
}

export function deleteTask(id) {
  const existing = get('SELECT id FROM tasks WHERE id = ?', id);
  if (!existing) throw notFound('태스크를 찾을 수 없습니다');
  run('DELETE FROM tasks WHERE id = ?', id);
  return { deleted: id };
}

export function reorderTasks(ids) {
  if (!Array.isArray(ids)) throw badRequest('ids: 배열이 필요합니다');
  if (ids.length > 500) throw badRequest('ids: 한 번에 500개까지');
  tx(() => {
    ids.forEach((rawId, i) => {
      const id = int(rawId, 'ids[]');
      run('UPDATE tasks SET sort_order = ?, updated_at = ? WHERE id = ?', (i + 1) * 1000, Date.now(), id);
    });
  });
  return { reordered: ids.length };
}

// ---- 프로젝트 ----

export function listProjects({ includeArchived = false } = {}) {
  const rows = all(`
    SELECT p.*,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','archived')) AS open_tasks,
      (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_tasks
    FROM projects p
    ${includeArchived ? '' : 'WHERE p.archived = 0'}
    ORDER BY p.sort_order ASC, p.id ASC
  `);
  return rows;
}

export function createProject(body) {
  const name = str(body.name, 'name', { min: 1, max: LIMITS.PROJECT_NAME });
  const res = run(
    `INSERT INTO projects(name, color, archived, created_at, sort_order, weekly_target_min)
     VALUES (?, ?, 0, ?, ?, ?)`,
    name,
    color(body.color, 'color', '#5b8def'),
    Date.now(),
    (get('SELECT COALESCE(MAX(sort_order),0) AS m FROM projects')?.m || 0) + 10,
    int(body.weekly_target_min, 'weekly_target_min', { min: 15, max: 4800, optional: true }),
  );
  return get('SELECT * FROM projects WHERE id = ?', Number(res.lastInsertRowid));
}

export function updateProject(id, body) {
  const existing = get('SELECT * FROM projects WHERE id = ?', id);
  if (!existing) throw notFound('프로젝트를 찾을 수 없습니다');
  const sets = [];
  const params = [];
  if ('name' in body) { sets.push('name = ?'); params.push(str(body.name, 'name', { min: 1, max: LIMITS.PROJECT_NAME })); }
  if ('color' in body) { sets.push('color = ?'); params.push(color(body.color)); }
  if ('archived' in body) { sets.push('archived = ?'); params.push(body.archived ? 1 : 0); }
  if ('weekly_target_min' in body) {
    sets.push('weekly_target_min = ?');
    params.push(int(body.weekly_target_min, 'weekly_target_min', { min: 15, max: 4800, optional: true }));
  }
  if ('sort_order' in body) {
    sets.push('sort_order = ?');
    params.push(int(body.sort_order, 'sort_order', { min: 0, max: 10_000_000 }));
  }
  if (!sets.length) return existing;
  params.push(id);
  run(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return get('SELECT * FROM projects WHERE id = ?', id);
}

export function deleteProject(id) {
  if (!get('SELECT id FROM projects WHERE id = ?', id)) throw notFound('프로젝트를 찾을 수 없습니다');
  run('DELETE FROM projects WHERE id = ?', id);
  return { deleted: id };
}
