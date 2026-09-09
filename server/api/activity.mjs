import { all, get, run, tx } from '../lib/db.mjs';
import { badRequest, notFound } from '../lib/http.mjs';
import { int, str, dayString, oneOf, color, safeRegex, ts } from '../lib/validate.mjs';
import { dayKey, dayRange, shiftDay } from '../lib/time.mjs';
import { invalidateRules, categorize, recategorizeAll, KINDS } from '../lib/categorize.mjs';
import { tracker } from '../tracker/tracker.mjs';
import { sanitizeTitle } from '../lib/text.mjs';
import { LIMITS } from '../../web/lib/limits.js';

const SELECT_ACTIVITY = `
  SELECT a.*, c.name AS category_name, c.color AS category_color, c.kind AS category_kind,
         t.title AS task_title
  FROM activity a
  LEFT JOIN categories c ON c.id = a.category_id
  LEFT JOIN tasks t ON t.id = a.task_id
`;

/** 하루치 활동 세그먼트. 짧은 노이즈는 기본적으로 걸러낸다. */
export function listActivity(query = {}) {
  const day = dayString(query.day, 'day', dayKey());
  const minSec = int(query.min_sec ?? 10, 'min_sec', { min: 0, max: 3600 });
  return all(
    `${SELECT_ACTIVITY} WHERE a.day = ? AND a.seconds >= ? ORDER BY a.started_at ASC LIMIT 2000`,
    day, minSec,
  );
}

/** 활동 기록을 앱/카테고리 기준으로 접어서 보여준다. */
export function activitySummary(query = {}) {
  const day = dayString(query.day, 'day', dayKey());

  const byCategory = all(`
    SELECT COALESCE(c.name, '미분류') AS name,
           COALESCE(c.color, '#6b7280') AS color,
           COALESCE(c.kind, 'other') AS kind,
           SUM(a.seconds) AS seconds,
           COUNT(*) AS segments
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day = ? AND a.idle = 0
    GROUP BY c.id
    ORDER BY seconds DESC
  `, day);

  const byApp = all(`
    SELECT a.app AS app,
           SUM(a.seconds) AS seconds,
           COUNT(*) AS segments,
           COALESCE(c.name, '미분류') AS category_name,
           COALESCE(c.color, '#6b7280') AS category_color,
           a.category_id AS category_id
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day = ? AND a.idle = 0
    GROUP BY a.app
    ORDER BY seconds DESC
    LIMIT 40
  `, day);

  const idle = get(
    'SELECT COALESCE(SUM(seconds), 0) AS seconds FROM activity WHERE day = ? AND idle = 1',
    day,
  ).seconds;

  const active = byCategory.reduce((sum, r) => sum + r.seconds, 0);
  return { day, active_sec: active, idle_sec: idle, by_category: byCategory, by_app: byApp };
}

/** 특정 앱 안에서 무엇을 하고 있었는지 (제목별). */
export function appDetail(query = {}) {
  const day = dayString(query.day, 'day', dayKey());
  const app = str(query.app, 'app', { min: 1, max: LIMITS.ACTIVITY_APP });
  return all(`
    SELECT a.title, SUM(a.seconds) AS seconds, COUNT(*) AS segments,
           MIN(a.started_at) AS first_at, MAX(a.ended_at) AS last_at
    FROM activity a
    WHERE a.day = ? AND a.app = ? AND a.idle = 0
    GROUP BY a.title
    ORDER BY seconds DESC
    LIMIT 60
  `, day, app);
}

/**
 * 기간 전체에서 활동 기록을 찾는다.
 *
 * "그 문서 언제 만졌더라", "이 고객사 건에 몇 시간 썼지" 같은 질문에 답하기 위한 것.
 * 창 제목·앱 이름을 함께 뒤지고, 날짜별 합계로 접어서 돌려준다.
 */
export function searchActivity(query = {}) {
  const q = str(query.q, 'q', { min: 1, max: 100 });
  const to = dayString(query.to, 'to', dayKey());
  const from = dayString(query.from, 'from', '2000-01-01');
  const like = `%${q}%`;

  const rows = all(`
    SELECT a.id, a.day, a.app, a.title, a.started_at, a.ended_at, a.seconds,
           COALESCE(c.name, '미분류') AS category_name,
           COALESCE(c.color, '#6b7280') AS category_color,
           COALESCE(t.title, '') AS task_title
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.idle = 0 AND a.day >= ? AND a.day <= ?
      AND (a.title LIKE ? OR a.app LIKE ?)
    ORDER BY a.started_at DESC
    LIMIT 500
  `, from, to, like, like);

  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, seconds: 0, items: [] });
    const bucket = byDay.get(r.day);
    bucket.seconds += r.seconds;
    if (bucket.items.length < 12) bucket.items.push(r);
  }

  // 메모도 함께 뒤진다.
  //
  // 사람이 직접 쓴 것은 회고와 주간 약속뿐인데, 정작 그것만 찾을 방법이 없었다.
  // "그 문제 언제 겪었더라", "지난번에 뭘 지키기로 했더라" 는 활동 기록이 아니라
  // 자기가 쓴 문장에서 나오는 답이다.
  const notes = all(
    `SELECT day, body FROM notes
     WHERE body LIKE ? AND day >= ? AND day <= ?
     ORDER BY day DESC LIMIT 30`,
    like, from, to,
  ).map((n) => ({
    day: n.day,
    // 맞은 줄만 골라 보여 준다 — 하루치 메모를 통째로 쏟아 놓으면 읽히지 않는다.
    lines: String(n.body).split('\n').filter((l) => l.toLowerCase().includes(q.toLowerCase())).slice(0, 4),
  })).filter((n) => n.lines.length);

  return {
    query: q,
    from,
    to,
    total_sec: rows.reduce((s, r) => s + r.seconds, 0),
    matches: rows.length,
    truncated: rows.length >= 500,
    days: [...byDay.values()].sort((a, b) => (a.day < b.day ? 1 : -1)),
    notes,
  };
}

/**
 * 아직 분류되지 않은 앱들.
 *
 * 미분류로 남은 시간은 모든 지표를 조용히 왜곡한다 — 몰입도, 방해 비율, 프로젝트 배분이
 * 전부 실제보다 작게 나온다. 쓰기 시작한 초기에 특히 많으므로, 시간이 큰 것부터 골라
 * 한 번에 정리할 수 있게 목록으로 뽑는다.
 */
export function unclassifiedApps(query = {}) {
  const days = int(query.days ?? 14, 'days', { min: 1, max: 365 });
  const to = dayString(query.to, 'to', dayKey());
  const from = shiftDay(to, -(days - 1));
  const minSec = int(query.min_sec ?? 300, 'min_sec', { min: 0, max: 86_400 });

  const rows = all(`
    SELECT a.app,
           SUM(a.seconds) AS seconds,
           COUNT(*) AS segments,
           MAX(a.started_at) AS last_at
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.idle = 0 AND a.day >= ? AND a.day <= ?
      AND (a.category_id IS NULL OR c.kind = 'other')
    GROUP BY a.app
    -- SUM 을 다시 쓴다. HAVING 안의 'seconds' 는 별칭이 아니라 activity.seconds 열로 읽혀,
    -- 세그먼트 하나의 길이(폴링 주기라 보통 몇 초)와 비교하게 된다 —
    -- 그러면 하루 종일 쓴 앱도 걸러져 목록이 통째로 비어 버린다.
    HAVING SUM(a.seconds) >= ?
    ORDER BY seconds DESC
    LIMIT 12
  `, from, to, minSec);

  // 각 앱에서 오래 머문 창 제목들.
  //
  // 창 제목이 여러 갈래인 앱(브라우저가 대표적)은 앱 하나로 뭉뚱그려 분류하면 안 된다.
  // "Chrome = 개발" 로 정해 버리면 그 안에서 본 유튜브까지 몰입 시간이 되어 지표가 통째로 망가진다.
  // 그래서 제목이 몇 갈래인지 세어 두고, 화면에서 제목 기준으로 나누도록 유도한다.
  for (const row of rows) {
    // 고를 대상은 **아직 분류되지 않은 제목만** 이다.
    //
    // 예전에는 그 앱의 모든 제목을 시간순으로 올렸다. 그러면 이미 규칙이 잡아 놓은 제목이
    // 절반쯤 섞여 나온다 — 실제로 Chrome 여덟 줄 중 셋이 이미 분류된 것이었다.
    // 정리하러 들어온 사람에게 정리할 필요가 없는 줄을 보여 주면, 가장 값진 클릭 몇 번을
    // 아무것도 바꾸지 않는 데 쓰게 된다.
    const titles = all(`
      SELECT a.title, SUM(a.seconds) AS seconds
      FROM activity a LEFT JOIN categories c ON c.id = a.category_id
      WHERE a.app = ? AND a.idle = 0 AND a.title != '' AND a.day >= ? AND a.day <= ?
        AND (a.category_id IS NULL OR c.kind = 'other')
      GROUP BY a.title ORDER BY seconds DESC LIMIT 8
    `, row.app, from, to);

    row.sample_title = titles[0]?.title || '';
    row.top_titles = titles;
    // 반대로 "앱 하나로 묶지 마라" 는 근거는 **전체** 제목 가짓수다.
    // 분류된 것까지 세어야 "이 앱에서는 여러 가지 일을 한다" 는 말이 성립한다.
    row.distinct_titles = get(`
      SELECT COUNT(DISTINCT title) AS n
      FROM activity
      WHERE app = ? AND idle = 0 AND title != '' AND day >= ? AND day <= ?
    `, row.app, from, to).n;
    // 제목이 여러 갈래면 앱 단위 분류가 위험하다.
    row.mixed = row.distinct_titles >= 5;
  }

  const total = get(`
    SELECT COALESCE(SUM(a.seconds), 0) AS seconds
    FROM activity a LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.idle = 0 AND a.day >= ? AND a.day <= ?
      AND (a.category_id IS NULL OR c.kind = 'other')
  `, from, to).seconds;

  const active = get(
    'SELECT COALESCE(SUM(seconds), 0) AS seconds FROM activity WHERE idle = 0 AND day >= ? AND day <= ?',
    from, to,
  ).seconds;

  return {
    from,
    to,
    days,
    apps: rows,
    unclassified_sec: total,
    active_sec: active,
    ratio: active > 0 ? Number((total / active).toFixed(3)) : 0,
  };
}

export function updateActivity(id, body) {
  const row = get('SELECT * FROM activity WHERE id = ?', id);
  if (!row) throw notFound('활동 기록을 찾을 수 없습니다');
  const sets = [];
  const params = [];
  if ('category_id' in body) {
    const catId = int(body.category_id, 'category_id', { optional: true });
    if (catId && !get('SELECT id FROM categories WHERE id = ?', catId)) throw badRequest('존재하지 않는 카테고리입니다');
    sets.push('category_id = ?');
    params.push(catId);
    // 손으로 정한 분류라는 표시. 카테고리를 비우면 다시 규칙에 맡긴다.
    sets.push('pinned = ?');
    params.push(catId ? 1 : 0);
  }
  if ('task_id' in body) {
    const taskId = int(body.task_id, 'task_id', { optional: true });
    if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) throw badRequest('존재하지 않는 태스크입니다');
    sets.push('task_id = ?');
    params.push(taskId);
  }
  if (!sets.length) return row;
  params.push(id);
  run(`UPDATE activity SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return get(`${SELECT_ACTIVITY} WHERE a.id = ?`, id);
}

/**
 * "이 앱은 앞으로 이 카테고리" — 규칙을 만들고 기존 기록도 함께 갱신한다.
 * 매번 개별 세그먼트를 고치는 대신 한 번에 학습시키는 것이 목적.
 */
export function teachRule(body) {
  const field = oneOf(body.field, 'field', ['app', 'title'], { optional: true, fallback: 'app' });
  const pattern = str(body.pattern, 'pattern', { min: 1, max: LIMITS.RULE_PATTERN });
  const categoryId = int(body.category_id, 'category_id');
  if (!get('SELECT id FROM categories WHERE id = ?', categoryId)) throw badRequest('존재하지 않는 카테고리입니다');
  const priority = int(body.priority ?? (field === 'title' ? 50 : 90), 'priority', { min: 1, max: 1000 });
  const isRegex = body.is_regex ? 1 : 0;
  if (isRegex) safeRegex(pattern);

  const applyExisting = body.apply_existing !== false;
  let updated = 0;

  // 같은 조건의 규칙이 이미 있으면 새로 만들지 않고 그것을 고친다.
  //
  // "이 앱을 항상 이렇게" 는 몇 번이고 눌리는 버튼이다. 누를 때마다 행이 하나씩 쌓이면
  // 규칙 목록이 같은 패턴으로 가득 차고, 우선순위가 다른 사본끼리 서로를 가린다 —
  // 그러면 어느 것이 실제로 적용되는지 화면만 보고는 알 수 없게 된다.
  const existing = get(
    'SELECT * FROM rules WHERE field = ? AND pattern = ? AND is_regex = ? ORDER BY priority ASC, id ASC LIMIT 1',
    field, pattern, isRegex,
  );

  tx(() => {
    if (existing) {
      run('UPDATE rules SET category_id = ? WHERE id = ?', categoryId, existing.id);
    } else {
      run(
        'INSERT INTO rules(field, pattern, is_regex, category_id, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        field, pattern, isRegex, categoryId, priority, Date.now(),
      );
    }
    invalidateRules();
    if (applyExisting) {
      // 정규식 규칙은 SQL LIKE 로 흉내 낼 수 없으므로 JS 쪽에서 걸러 낸다.
      const column = field === 'app' ? 'app' : 'title';
      // `pinned = 1` 은 사람이 직접 정한 분류다. 여기는 `recategorizeAll()` 과 다른 길이라
      // 그쪽에만 조건을 걸어 두면, 정작 사람들이 가장 많이 쓰는 이 버튼에서 그대로 덮인다.
      const rows = isRegex
        ? all(`SELECT id, app, title, ${column} AS value FROM activity WHERE idle = 0 AND pinned = 0`)
          .filter((r) => new RegExp(pattern, 'i').test(r.value || ''))
        : all(
            `SELECT id, app, title FROM activity WHERE idle = 0 AND pinned = 0 AND ${column} LIKE ?`,
            `%${pattern}%`,
          );

      // 새 규칙의 카테고리를 그냥 밀어 넣으면 안 된다.
      //
      // 규칙에는 우선순위가 있고, 창 제목 규칙이 앱 규칙보다 먼저 검사된다.
      // 그런데 여기서 무조건 덮어쓰면 나중에 만든 앱 규칙("Vivaldi = 리서치")이
      // 앞서 세워 둔 제목 규칙("YouTube = 방해요소")의 결과를 지워 버린다.
      // 그래서 전체 규칙을 다시 태워 나온 결과를 쓴다 — 화면에 보이는 우선순위대로.
      for (const r of rows) {
        const resolved = categorize({ app: r.app, title: r.title });
        // SQLite 의 IS NOT 은 NULL 도 제대로 비교한다 — 값이 실제로 바뀔 때만 센다.
        const res = run(
          'UPDATE activity SET category_id = ? WHERE id = ? AND category_id IS NOT ?',
          resolved, r.id, resolved,
        );
        if (Number(res.changes)) updated++;
      }
    }
  });
  return { created: !existing, replaced: Boolean(existing), updated };
}

export function listRules() {
  return all(`
    SELECT r.*, c.name AS category_name, c.color AS category_color
    FROM rules r
    LEFT JOIN categories c ON c.id = r.category_id
    ORDER BY r.priority ASC, r.id ASC
  `);
}

/**
 * 규칙 수정.
 *
 * 우선순위를 고칠 수 있어야 "브라우저는 미분류지만 제목에 GitHub 이 있으면 개발" 같은
 * 겹치는 규칙들의 순서를 사용자가 정리할 수 있다.
 */
export function updateRule(id, body) {
  const existing = get('SELECT * FROM rules WHERE id = ?', id);
  if (!existing) throw notFound('규칙을 찾을 수 없습니다');

  const sets = [];
  const params = [];
  if ('field' in body) {
    sets.push('field = ?');
    params.push(oneOf(body.field, 'field', ['app', 'title']));
  }
  if ('pattern' in body) {
    const pattern = str(body.pattern, 'pattern', { min: 1, max: LIMITS.RULE_PATTERN });
    if (body.is_regex ?? existing.is_regex) safeRegex(pattern);
    sets.push('pattern = ?');
    params.push(pattern);
  }
  if ('is_regex' in body) {
    const isRegex = body.is_regex ? 1 : 0;
    if (isRegex) safeRegex(body.pattern ?? existing.pattern);
    sets.push('is_regex = ?');
    params.push(isRegex);
  }
  if ('category_id' in body) {
    const catId = int(body.category_id, 'category_id');
    if (!get('SELECT id FROM categories WHERE id = ?', catId)) throw badRequest('존재하지 않는 카테고리입니다');
    sets.push('category_id = ?');
    params.push(catId);
  }
  if ('priority' in body) {
    sets.push('priority = ?');
    params.push(int(body.priority, 'priority', { min: 1, max: 1000 }));
  }
  if (!sets.length) return existing;

  params.push(id);
  run(`UPDATE rules SET ${sets.join(', ')} WHERE id = ?`, ...params);
  invalidateRules();
  // 규칙을 고쳤으면 과거 기록도 따라와야 한다.
  //
  // 타임라인에서 규칙을 만들 때는 과거까지 정리해 주면서, 설정에서 같은 규칙을 고칠 때는
  // 그러지 않으면 규칙 목록과 실제 분류가 조용히 어긋난다. 사용자는 "전체 다시 분류"
  // 버튼을 눌러야 한다는 것을 알 방법이 없다.
  const updated = recategorizeAll();
  return { ...get('SELECT * FROM rules WHERE id = ?', id), updated };
}

export function deleteRule(id) {
  if (!get('SELECT id FROM rules WHERE id = ?', id)) throw notFound('규칙을 찾을 수 없습니다');
  run('DELETE FROM rules WHERE id = ?', id);
  invalidateRules();
  // 규칙을 지웠으면 그 규칙으로 분류됐던 기록도 다시 판정해야 한다 — 위와 같은 이유.
  const updated = recategorizeAll();
  return { deleted: id, updated };
}

export function listCategories() {
  return all(`
    SELECT c.*,
      (SELECT COUNT(*) FROM rules r WHERE r.category_id = c.id) AS rule_count,
      (SELECT COUNT(*) FROM activity a WHERE a.category_id = c.id) AS activity_count
    FROM categories c
    ORDER BY c.sort_order ASC, c.id ASC
  `);
}

export function createCategory(body) {
  const name = str(body.name, 'name', { min: 1, max: LIMITS.CATEGORY_NAME });
  if (get('SELECT id FROM categories WHERE name = ?', name)) {
    throw badRequest('같은 이름의 카테고리가 이미 있습니다');
  }
  const kind = oneOf(body.kind, 'kind', KINDS);
  const res = run(
    'INSERT INTO categories(name, kind, color, sort_order) VALUES (?, ?, ?, ?)',
    name,
    kind,
    color(body.color, 'color', '#6b7280'),
    (get('SELECT COALESCE(MAX(sort_order), 0) AS m FROM categories')?.m || 0) + 10,
  );
  return get('SELECT * FROM categories WHERE id = ?', Number(res.lastInsertRowid));
}

export function updateCategory(id, body) {
  const existing = get('SELECT * FROM categories WHERE id = ?', id);
  if (!existing) throw notFound('카테고리를 찾을 수 없습니다');

  const sets = [];
  const params = [];
  if ('name' in body) {
    const name = str(body.name, 'name', { min: 1, max: LIMITS.CATEGORY_NAME });
    const clash = get('SELECT id FROM categories WHERE name = ? AND id != ?', name, id);
    if (clash) throw badRequest('같은 이름의 카테고리가 이미 있습니다');
    sets.push('name = ?');
    params.push(name);
  }
  if ('kind' in body) {
    // 마지막 남은 '미분류'(other)를 다른 종류로 바꾸면 분류 실패 시 갈 곳이 없어진다.
    if (existing.kind === 'other' && body.kind !== 'other') {
      const others = get("SELECT COUNT(*) AS n FROM categories WHERE kind = 'other'").n;
      if (others <= 1) throw badRequest("'미분류' 종류의 카테고리는 최소 하나 남겨야 합니다");
    }
    sets.push('kind = ?');
    params.push(oneOf(body.kind, 'kind', KINDS));
  }
  if ('color' in body) { sets.push('color = ?'); params.push(color(body.color)); }
  if ('sort_order' in body) {
    sets.push('sort_order = ?');
    params.push(int(body.sort_order, 'sort_order', { min: 0, max: 100_000 }));
  }
  if (!sets.length) return existing;

  params.push(id);
  run(`UPDATE categories SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return get('SELECT * FROM categories WHERE id = ?', id);
}

/**
 * 카테고리 삭제.
 * 딸린 규칙은 함께 사라지고(외래키 CASCADE), 그 카테고리로 분류돼 있던 활동 기록은
 * 분류가 비워진다(SET NULL). 기록 자체는 지우지 않는다 — 분류는 해석일 뿐이므로.
 */
export function deleteCategory(id) {
  const existing = get('SELECT * FROM categories WHERE id = ?', id);
  if (!existing) throw notFound('카테고리를 찾을 수 없습니다');
  if (existing.kind === 'other') {
    const others = get("SELECT COUNT(*) AS n FROM categories WHERE kind = 'other'").n;
    if (others <= 1) throw badRequest("'미분류' 카테고리는 분류 실패 시의 기본값이라 지울 수 없습니다");
  }
  const affected = get('SELECT COUNT(*) AS n FROM activity WHERE category_id = ?', id).n;
  // 손으로 이 카테고리를 골라 뒀던 기록은 고정을 풀어 준다.
  //
  // 카테고리를 지우면 그 기록의 category_id 는 NULL 이 된다(ON DELETE SET NULL).
  // 그런데 고정 표시가 남아 있으면 규칙도, "전체 다시 분류" 도 그 행을 건드리지 못한다 —
  // 사람이 고른 카테고리는 이미 없어졌는데 그 자리만 영원히 비어 있게 된다.
  run('UPDATE activity SET pinned = 0 WHERE category_id = ? AND pinned = 1', id);
  run('DELETE FROM categories WHERE id = ?', id);
  invalidateRules();
  return { deleted: id, unclassified: affected };
}

/**
 * 수동 시간 기록 — 자동 추적이 놓친 오프라인 작업(회의, 통화, 종이 작업)을 채워 넣는다.
 */
/**
 * 어떤 시간 구간을 비운다 — 그 구간과 겹치는 기존 기록을 걷어내거나 잘라 낸다.
 *
 * 수동 입력이 하는 말은 "이 시간에는 실제로 이것을 하고 있었다" 이다. 그런데 그냥 한 줄
 * 더 넣으면 같은 시각이 두 번 세어진다 — 자리비움 30분 위에 회의 30분을 얹으면 하루가
 * 한 시간 늘어나고, 활동 시간·몰입 시간·카테고리 배분이 전부 조금씩 부풀어 오른다.
 * 화면 어디에도 "겹쳤습니다" 라고 나오지 않으므로 아무도 눈치채지 못한다.
 *
 * 그래서 넣기 전에 자리를 비운다. 구간 안에 완전히 들어간 기록은 지우고, 걸친 것은 자르고,
 * 구간을 통째로 감싸는 것은 앞뒤로 쪼갠다.
 */
function clearWindow(from, to) {
  const rows = all('SELECT * FROM activity WHERE started_at < ? AND ended_at > ?', to, from);
  let removed = 0;
  let trimmed = 0;

  const setBounds = (row, start, end) => {
    const seconds = Math.round((end - start) / 1000);
    if (seconds < 1) {
      run('DELETE FROM activity WHERE id = ?', row.id);
      removed++;
      return;
    }
    run(
      'UPDATE activity SET started_at = ?, ended_at = ?, seconds = ?, day = ? WHERE id = ?',
      start, end, seconds, dayKey(start), row.id,
    );
    trimmed++;
  };

  for (const row of rows) {
    const startsInside = row.started_at >= from;
    const endsInside = row.ended_at <= to;

    if (startsInside && endsInside) {
      run('DELETE FROM activity WHERE id = ?', row.id);
      removed++;
    } else if (!startsInside && !endsInside) {
      // 구간을 통째로 감싼다 — 뒤쪽 조각을 새 행으로 떼어 내고 원래 행은 앞쪽만 남긴다.
      run(
        `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.app, row.title, row.exe, to, row.ended_at, Math.round((row.ended_at - to) / 1000),
        row.idle, row.category_id, row.task_id, dayKey(to),
      );
      setBounds(row, row.started_at, from);
    } else if (startsInside) {
      setBounds(row, to, row.ended_at);
    } else {
      setBounds(row, row.started_at, from);
    }
  }

  return { removed, trimmed };
}

export function addManualActivity(body) {
  const startedAt = ts(body.started_at, 'started_at');
  const minutes = int(body.minutes, 'minutes', { min: 1, max: 720 });
  const endedAt = startedAt + minutes * 60_000;
  // 자동 추적이 다듬는 것과 **같은 규칙**으로 다듬는다.
  //
  // 추적기는 보이지 않는 글자와 줄바꿈·탭을 걷어 내는데, 손으로 넣는 쪽은 그냥 trim 만 했다.
  // 그래서 붙여 넣기 한 번에 줄바꿈이 든 제목이 들어가고, 한 줄로 보여 주는 표에서
  // 줄이 깨지고 CSV 에도 그대로 실려 나갔다. 같은 칸이 들어온 길에 따라 다르게 다뤄지면,
  // 나중에 그 칸을 믿고 쓰는 코드가 전부 두 경우를 다 신경 써야 한다.
  const app = sanitizeTitle(str(body.app, 'app', { min: 1, max: LIMITS.ACTIVITY_APP })).slice(0, LIMITS.ACTIVITY_APP);
  if (!app) throw badRequest('app: 값이 필요합니다');
  const title = sanitizeTitle(str(body.title, 'title', { max: LIMITS.ACTIVITY_TITLE })).slice(0, LIMITS.ACTIVITY_TITLE);
  const chosen = int(body.category_id, 'category_id', { optional: true });
  // 사용자가 카테고리를 고른 경우에만 고정한다. 비워 두면 규칙이 정한 것이므로
  // 나중에 규칙이 좋아지면 함께 좋아지는 편이 낫다.
  const categoryId = chosen ?? categorize({ app, title });
  const pinned = chosen ? 1 : 0;
  const taskId = int(body.task_id, 'task_id', { optional: true });
  if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) throw badRequest('존재하지 않는 태스크입니다');

  // 겹치는 기록을 남겨 두면 같은 시각이 두 번 세어진다. 기본값은 자리를 비우는 쪽이다 —
  // 사용자가 "이 시간에는 이것을 했다" 고 말한 이상, 그 구간의 자동 기록은 틀린 것이다.
  const replace = body.replace_overlap !== false;
  const cleared = replace ? clearWindow(startedAt, endedAt) : { removed: 0, trimmed: 0 };

  const res = run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, task_id, day, pinned)
     VALUES (?, ?, 'manual', ?, ?, ?, 0, ?, ?, ?, ?)`,
    app, title, startedAt, endedAt, minutes * 60, categoryId, taskId, dayKey(startedAt), pinned,
  );

  // 추적기가 붙잡고 있던 행을 잘랐을 수 있다. 그대로 두면 다음 폴링이 잘라 낸 자리를
  // 도로 늘려 놓는다 — 놓아 주고 다음 샘플에서 다시 열게 한다.
  if (cleared.removed || cleared.trimmed) tracker.releaseOpenSegment();

  return { ...get(`${SELECT_ACTIVITY} WHERE a.id = ?`, Number(res.lastInsertRowid)), cleared };
}

/** 수동 입력 전에 "무엇이 지워지는지" 보여 주기 위한 미리보기. */
export function manualPreview(query = {}) {
  const startedAt = ts(query.started_at, 'started_at');
  const minutes = int(query.minutes, 'minutes', { min: 1, max: 720 });
  const endedAt = startedAt + minutes * 60_000;
  const rows = all(
    `SELECT app, idle, SUM(seconds) AS seconds, COUNT(*) AS n
     FROM activity WHERE started_at < ? AND ended_at > ?
     GROUP BY app, idle ORDER BY SUM(seconds) DESC, app ASC LIMIT 6`,
    endedAt, startedAt,
  );
  const total = get(
    'SELECT COUNT(*) AS n, COALESCE(SUM(seconds), 0) AS seconds FROM activity WHERE started_at < ? AND ended_at > ?',
    endedAt, startedAt,
  );
  return { from: startedAt, to: endedAt, count: total.n, seconds: total.seconds, rows };
}

/**
 * 아직 정리하지 않은 긴 자리비움 구간.
 *
 * 회의·통화·오프라인 검토처럼 화면 앞에 없던 시간은 자동 추적으로는 "자리비움"으로만 남는다.
 * 그대로 두면 하루가 실제보다 비어 보이므로, 긴 구간만 골라 사용자에게 되묻는다.
 */
export function listGaps(query = {}) {
  const day = dayString(query.day, 'day', dayKey());
  const minSec = int(query.min_sec ?? 900, 'min_sec', { min: 60, max: 14_400 });
  // 세 시간을 넘는 공백은 물어볼 것도 없다 — 퇴근했거나 PC 를 켜 둔 채 잔 것이다.
  // 그런 구간까지 되묻기 목록에 넣으면 확인 자체가 일이 된다.
  const maxSec = int(query.max_sec ?? 3 * 3600, 'max_sec', { min: 600, max: 86_400 });
  return all(`
    SELECT id, started_at, ended_at, seconds, day
    FROM activity
    WHERE day = ? AND idle = 1 AND reviewed = 0
      AND seconds >= ? AND seconds <= ?
    ORDER BY started_at ASC
    LIMIT 12
  `, day, minSec, maxSec);
}

/**
 * 자리비움을 정리할 때 쓸 **그 사람의** 이름표.
 *
 * 기본 버튼은 회의·오프라인 작업·학습·휴식 넷이다. 그런데 자리를 비우는 이유는 직업마다
 * 다르다 — 교사에게는 대부분이 '수업' 이고, 영업에게는 '외근' 이다. 그 사람에게는
 * 네 버튼이 전부 헛것이고, 매번 "직접 입력" 을 눌러 같은 말을 다시 적어야 한다.
 * 하루에 여덟 구간이면 그 순간 이 기능은 안 쓰이게 된다.
 *
 * 그래서 이미 쓴 이름표를 많이 쓴 순서로 돌려준다. 첫날은 기본값대로지만,
 * 한 번 "수업" 이라고 적고 나면 다음부터는 그것이 버튼이 된다.
 *
 * 카테고리가 지워진 이름표는 빼고 준다 — 눌러도 미분류가 되는 버튼은 없느니만 못하다.
 */
export function gapLabels(query = {}) {
  const limit = int(query.limit ?? 4, 'limit', { min: 1, max: 8 });
  return all(`
    SELECT a.app, a.category_id, c.name AS category_name, COUNT(*) AS uses,
           MAX(a.started_at) AS last_at
    FROM activity a
    JOIN categories c ON c.id = a.category_id
    WHERE a.exe = 'resolved' AND a.app != ''
    GROUP BY a.app, a.category_id
    ORDER BY uses DESC, last_at DESC
    LIMIT ?
  `, limit);
}

/**
 * 자리비움 구간 처리.
 *  - ignore=true  → 그냥 확인 처리하고 자리비움으로 남긴다
 *  - 그 외        → 실제 활동으로 바꾼다 (회의, 오프라인 작업 등)
 */
export function resolveGap(id, body = {}) {
  const row = get('SELECT * FROM activity WHERE id = ?', id);
  if (!row) throw notFound('활동 기록을 찾을 수 없습니다');
  if (!row.idle) throw badRequest('자리비움 기록이 아닙니다');

  if (body.ignore) {
    run('UPDATE activity SET reviewed = 1 WHERE id = ?', id);
    return get(`${SELECT_ACTIVITY} WHERE a.id = ?`, id);
  }

  const app = sanitizeTitle(str(body.app, 'app', { min: 1, max: LIMITS.ACTIVITY_APP })).slice(0, LIMITS.ACTIVITY_APP);
  if (!app) throw badRequest('app: 값이 필요합니다');
  const categoryId = int(body.category_id, 'category_id', { optional: true });
  if (categoryId && !get('SELECT id FROM categories WHERE id = ?', categoryId)) {
    throw badRequest('존재하지 않는 카테고리입니다');
  }
  const taskId = int(body.task_id, 'task_id', { optional: true });
  if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) throw badRequest('존재하지 않는 태스크입니다');

  run(
    `UPDATE activity
     SET idle = 0, reviewed = 1, app = ?, title = ?, exe = 'resolved',
         category_id = ?, task_id = ?, pinned = ?
     WHERE id = ?`,
    app,
    sanitizeTitle(str(body.title, 'title', { max: LIMITS.ACTIVITY_TITLE })).slice(0, LIMITS.ACTIVITY_TITLE),
    categoryId ?? categorize({ app, title: body.title || '' }),
    taskId,
    // "이 자리비움은 회의였다" 는 사람이 아는 사실이다. 규칙이 뒤집게 두지 않는다.
    // 카테고리를 고르지 않았다면 규칙이 정한 것이므로 그대로 규칙에 맡긴다.
    categoryId ? 1 : 0,
    id,
  );

  // 추적기가 바로 이 행을 붙잡고 있을 수 있다 — 자리를 비운 채 그 구간을 정리하는 경우다.
  // 그대로 두면 자리비움인 줄 알고 계속 늘려서, 방금 "회의 40분" 이라고 적어 둔 것이
  // 자리에 돌아올 때까지 자라난다. 놓아 주면 다음 샘플에서 새로 연다.
  tracker.releaseOpenSegment();

  return get(`${SELECT_ACTIVITY} WHERE a.id = ?`, id);
}

export function deleteActivity(id) {
  if (!get('SELECT id FROM activity WHERE id = ?', id)) throw notFound('활동 기록을 찾을 수 없습니다');
  run('DELETE FROM activity WHERE id = ?', id);
  return { deleted: id };
}

/** 하루의 시간대별 활동 밀도 (0~23시, 초 단위). */
export function hourlyDensity(day) {
  const [start, end] = dayRange(day);
  const rows = all(
    'SELECT started_at, ended_at, seconds, idle, category_id FROM activity WHERE day = ? ORDER BY started_at',
    day,
  );
  const buckets = Array.from({ length: 24 }, (_, h) => ({ hour: h, active: 0, idle: 0 }));
  for (const r of rows) {
    // 시각이 숫자가 아니면(손댄 데이터·옛 백업) 이 행은 아예 건너뛴다.
    // 그냥 두면 NaN 이 버킷에 더해져 히트맵 한 칸이 통째로 사라진다.
    if (!Number.isFinite(Number(r.started_at)) || !Number.isFinite(Number(r.ended_at))) continue;
    let s = Math.max(Number(r.started_at), start);
    const e = Math.min(Number(r.ended_at), end);
    while (s < e) {
      const d = new Date(s);
      const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      // 시각이 이상한 기록(가져온 백업 등)이 와도 루프가 멈추지 않는 일이 없도록 한 걸음은 반드시 전진한다.
      if (hourEnd <= s) { s = e; break; }
      const chunkEnd = Math.min(e, hourEnd);
      const sec = Math.round((chunkEnd - s) / 1000);
      const bucket = buckets[d.getHours()];
      if (r.idle) bucket.idle += sec;
      else bucket.active += sec;
      s = chunkEnd;
    }
  }
  return buckets;
}

/**
 * 시간 구간을 통째로 태스크·카테고리에 지정한다.
 *
 * 자동 추적은 창 제목이 바뀔 때마다 기록을 나누므로, 두 시간짜리 작업 하나가
 * 수십 줄로 흩어져 있다. 그것을 한 줄씩 눌러 태스크에 연결하라고 하면 아무도 안 한다 —
 * 그래서 실제로는 "집중 세션을 켠 사람"만 태스크별 시간이 쌓이고, 나머지는 영영 비어 있다.
 *
 * 구간에 **걸치는** 기록을 모두 잡는다. 사람이 타임라인을 보고 "이 언저리" 를 고르는
 * 것이므로, 경계에 반쯤 걸친 기록을 빼면 오히려 예상과 어긋난다.
 * 자리비움은 건드리지 않는다 — 자리에 없던 시간을 일한 시간으로 만들면 안 된다.
 */
const RANGE_OVERLAP = 'idle = 0 AND started_at < ? AND ended_at > ?';

function rangeBounds(query) {
  const from = ts(query.from, 'from');
  const to = ts(query.to, 'to');
  if (to <= from) throw badRequest('to: 끝이 시작보다 뒤여야 합니다');
  if (to - from > 24 * 3600_000) throw badRequest('한 번에 24시간까지만 지정할 수 있습니다');
  return [from, to];
}

/** 구간에 무엇이 들어 있는지 미리 보여 준다 — 무엇이 바뀌는지 모르고 누르지 않도록. */
export function rangePreview(query = {}) {
  const [from, to] = rangeBounds(query);
  const summary = get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(seconds), 0) AS seconds,
            MIN(started_at) AS first_at, MAX(ended_at) AS last_at
     FROM activity WHERE ${RANGE_OVERLAP}`,
    to, from,
  );
  const apps = all(
    `SELECT app, SUM(seconds) AS seconds FROM activity
     WHERE ${RANGE_OVERLAP}
     -- 같은 길이일 때 순서가 흔들리지 않도록 이름으로 한 번 더 정렬한다.
     GROUP BY app ORDER BY SUM(seconds) DESC, app ASC LIMIT 5`,
    to, from,
  );
  return { from, to, count: summary.n, seconds: summary.seconds, first_at: summary.first_at, last_at: summary.last_at, apps };
}

export function assignRange(body = {}) {
  const [from, to] = rangeBounds(body);

  const sets = [];
  const params = [];
  if ('task_id' in body) {
    const taskId = int(body.task_id, 'task_id', { optional: true });
    if (taskId && !get('SELECT id FROM tasks WHERE id = ?', taskId)) throw badRequest('존재하지 않는 태스크입니다');
    sets.push('task_id = ?');
    params.push(taskId);
  }
  if ('category_id' in body) {
    const catId = int(body.category_id, 'category_id', { optional: true });
    if (catId && !get('SELECT id FROM categories WHERE id = ?', catId)) throw badRequest('존재하지 않는 카테고리입니다');
    sets.push('category_id = ?');
    params.push(catId);
    sets.push('pinned = ?');
    params.push(catId ? 1 : 0);
  }
  if (!sets.length) throw badRequest('지정할 태스크나 카테고리가 필요합니다');

  const res = run(
    `UPDATE activity SET ${sets.join(', ')} WHERE ${RANGE_OVERLAP}`,
    ...params, to, from,
  );
  return { updated: Number(res.changes), from, to };
}

/**
 * 창 제목에서 규칙 후보 낱말을 뽑는다.
 *
 * 브라우저 제목은 `"<페이지> - <사이트> - Chrome"` 처럼 생겼고, 페이지 이름은 매번 다르다.
 * 그래서 제목 하나하나를 눌러 분류하면 오늘 것만 정리되고 내일 또 새 제목이 생긴다 —
 * 미분류가 줄지 않는 진짜 이유가 이것이다.
 *
 * 대신 여러 제목에 **되풀이해서 나오는 조각**을 찾으면 규칙 하나가 계속 일한다.
 * "관리 콘솔", "GitHub", "나무위키" 같은 것들이다. 시간이 큰 순서로 돌려주므로
 * 위에서 서너 개만 눌러도 미분류의 대부분이 정리된다.
 *
 * 두 가지를 지킨다.
 *  - 제목 **두 개 이상**에 나오는 것만 후보로 둔다. 한 제목에만 있는 낱말로 규칙을 만드는 것은
 *    그 제목을 직접 누르는 것과 같고, 나중에 엉뚱한 것까지 잡을 위험만 남는다.
 *  - 앱 이름 자체는 뺀다. 모든 제목에 들어 있어서 늘 1등이 되는데, 그건 앱 단위 규칙이다.
 */
const TITLE_SEPARATORS = /[-|—–·•:/\\]+/;

function tokenizeTitle(title, appName) {
  const appWords = new Set(
    String(appName || '').toLowerCase().split(/\s+/).filter(Boolean),
  );
  const out = new Set();

  const phrases = String(title)
    .split(TITLE_SEPARATORS)
    .map((p) => p.trim())
    .filter(Boolean);

  for (const phrase of phrases) {
    const lower = phrase.toLowerCase();
    // 앱 이름과 같거나 앱 이름 안에 들어 있는 조각은 뺀다 ("Chrome" ⊂ "Google Chrome").
    const isAppName = appWords.has(lower)
      || String(appName || '').toLowerCase().includes(lower)
      || lower.includes(String(appName || '').toLowerCase());
    if (isAppName) continue;
    if (phrase.length >= 2 && phrase.length <= 40) out.add(phrase);

    // 구절 안의 낱말도 후보로 둔다 — "받은편지함" 처럼 구절이 길 때를 위해.
    for (const word of phrase.split(/\s+/)) {
      const w = word.trim();
      if (w.length < 2 || w.length > 20) continue;
      if (appWords.has(w.toLowerCase())) continue;
      if (/^[\d.,%]+$/.test(w)) continue; // 숫자만 있는 것은 규칙이 될 수 없다
      out.add(w);
    }
  }
  return [...out];
}

export function titleSuggestions(query = {}) {
  const app = str(query.app, 'app', { min: 1, max: LIMITS.ACTIVITY_APP });
  const days = int(query.days ?? 14, 'days', { min: 1, max: 365 });
  const to = dayString(query.to, 'to', dayKey());
  const from = shiftDay(to, -(days - 1));

  // 오래 머문 제목부터 500개까지만 본다. 브라우저를 일 년 쓰면 제목이 수천 종이 되는데,
  // 뒤쪽의 몇 초짜리들은 후보 조건(제목 2개 이상, 1분 이상)을 어차피 넘지 못한다.
  const rows = all(`
    SELECT a.title, SUM(a.seconds) AS seconds
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.app = ? AND a.idle = 0 AND a.title != ''
      AND a.day >= ? AND a.day <= ?
      AND (a.category_id IS NULL OR c.kind = 'other')
    GROUP BY a.title
    ORDER BY SUM(a.seconds) DESC
    LIMIT 500
  `, app, from, to);

  const tally = new Map();
  for (const row of rows) {
    for (const token of tokenizeTitle(row.title, app)) {
      const key = token.toLowerCase();
      const entry = tally.get(key) || { token, seconds: 0, titles: 0, sample: row.title };
      entry.seconds += row.seconds;
      entry.titles += 1;
      if (row.seconds > 0 && entry.seconds === row.seconds) entry.sample = row.title;
      tally.set(key, entry);
    }
  }

  // 합계는 잘라낸 뒤가 아니라 전체를 센다 — 화면에 "미분류의 몇 %" 로 나가는 값이라서.
  const total = get(`
    SELECT COALESCE(SUM(a.seconds), 0) AS seconds
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.app = ? AND a.idle = 0 AND a.title != ''
      AND a.day >= ? AND a.day <= ?
      AND (a.category_id IS NULL OR c.kind = 'other')
  `, app, from, to).seconds;

  const candidates = [...tally.values()].filter((t) => t.titles >= 2 && t.seconds >= 60);

  // "관리", "관리 콘솔", "콘솔" 이 셋 다 올라오면 고르는 사람만 피곤하다.
  // 오늘 잡는 것이 완전히 같다면 **더 긴 쪽**만 남긴다 — 짧은 쪽이 미래를 더 넓게 잡긴 하지만,
  // 그만큼 엉뚱한 것까지 잡는다. 분류 규칙에서 잘못 잡는 쪽의 대가가 더 크다.
  const kept = candidates.filter((t) => !candidates.some((u) => (
    u !== t
    && u.token.length > t.token.length
    && u.token.toLowerCase().includes(t.token.toLowerCase())
    && u.seconds === t.seconds
    && u.titles === t.titles
  )));

  const suggestions = kept
    .sort((a, b) => b.seconds - a.seconds || a.token.localeCompare(b.token))
    .slice(0, 8)
    .map((t) => ({ ...t, share: total ? Number((t.seconds / total).toFixed(3)) : 0 }));

  return {
    app,
    from,
    to,
    // 살펴본 제목 수. 잘렸다면 화면에서 "일부만 본 결과" 임을 알 수 있어야 한다.
    examined_titles: rows.length,
    truncated: rows.length >= 500,
    unclassified_sec: total,
    suggestions,
  };
}
