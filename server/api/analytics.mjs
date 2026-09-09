import { all, get, setting } from '../lib/db.mjs';
import { dayString, int } from '../lib/validate.mjs';
import { badRequest } from '../lib/http.mjs';
import { dayKey, dayRange, lastDays, weekOf, shiftDay } from '../lib/time.mjs';
import { hourlyDensity } from './activity.mjs';

/** 몰입 블록 판정 기준 (설정으로 덮어쓸 수 있다). */
const DEFAULTS = {
  deep_block_min: 15,        // 이 시간 이상 이어져야 "몰입 블록"
  deep_tolerance_sec: 120,   // 블록을 깨지 않는 짧은 이탈 허용치
  gap_break_sec: 300,        // 이보다 긴 공백이면 블록 종료
  daily_deep_target_min: 180,
  daily_focus_target: 6,     // 하루 목표 집중 세션 수
};

function conf(key) {
  const raw = setting(`analytics_${key}`, null);
  const n = raw === null ? DEFAULTS[key] : Number(raw);
  return Number.isFinite(n) ? n : DEFAULTS[key];
}

const DEEP_KINDS = new Set(['deep']);

function segmentsFor(day) {
  return all(`
    SELECT a.id, a.app, a.title, a.started_at, a.ended_at, a.seconds, a.idle,
           COALESCE(c.kind, 'other') AS kind,
           COALESCE(c.name, '미분류') AS category_name,
           COALESCE(c.color, '#6b7280') AS category_color
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day = ?
    ORDER BY a.started_at ASC
  `, day);
}

/**
 * 몰입 블록 추출.
 *
 * 규칙: deep 카테고리 구간이 이어지는 동안 블록이 자란다. 중간에 다른 종류가 끼어들어도
 * 누적 이탈이 tolerance 이하이면 블록을 유지한다(그 시간은 몰입 시간으로 세지 않는다).
 * 이탈이 tolerance 를 넘거나 기록 공백이 gap_break 를 넘으면 블록을 닫는다.
 */
export function deepBlocks(segments, {
  minMin = conf('deep_block_min'),
  toleranceSec = conf('deep_tolerance_sec'),
  gapSec = conf('gap_break_sec'),
} = {}) {
  const blocks = [];
  let cur = null;

  const close = () => {
    if (cur && cur.deep_sec >= minMin * 60) blocks.push(cur);
    cur = null;
  };

  let prevEnd = null;
  for (const s of segments) {
    if (prevEnd !== null && s.started_at - prevEnd > gapSec * 1000) close();
    prevEnd = s.ended_at;

    const isDeep = !s.idle && DEEP_KINDS.has(s.kind);
    if (isDeep) {
      if (!cur) cur = { start: s.started_at, end: s.ended_at, deep_sec: 0, breaks_sec: 0, apps: new Map() };
      cur.end = s.ended_at;
      cur.deep_sec += s.seconds;
      cur.apps.set(s.app, (cur.apps.get(s.app) || 0) + s.seconds);
      cur.pendingBreak = 0; // 다시 몰입으로 돌아왔으니 이탈 누적을 초기화
    } else if (cur) {
      cur.pendingBreak = (cur.pendingBreak || 0) + s.seconds;
      cur.breaks_sec += s.seconds;
      if (cur.pendingBreak > toleranceSec) {
        // 이탈이 허용치를 넘으면 이탈 직전까지가 블록.
        cur.breaks_sec -= cur.pendingBreak;
        close();
      }
    }
  }
  close();

  return blocks.map((b) => ({
    start: b.start,
    end: b.end,
    deep_sec: b.deep_sec,
    breaks_sec: Math.max(0, b.breaks_sec),
    span_sec: Math.round((b.end - b.start) / 1000),
    top_app: [...b.apps.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] || '',
  }));
}

/** 앱 전환 횟수 — 같은 앱으로의 연속 전환은 세지 않는다. */
function switchCount(segments) {
  let switches = 0;
  let prevApp = null;
  for (const s of segments) {
    if (s.idle) { prevApp = null; continue; }
    if (prevApp !== null && s.app !== prevApp) switches++;
    prevApp = s.app;
  }
  return switches;
}

function sumByKind(segments) {
  const out = {};
  for (const s of segments) {
    if (s.idle) { out.idle = (out.idle || 0) + s.seconds; continue; }
    out[s.kind] = (out[s.kind] || 0) + s.seconds;
  }
  return out;
}

function focusStats(day) {
  const rows = all(
    "SELECT * FROM focus_sessions WHERE day = ? AND kind = 'focus'",
    day,
  );
  const completed = rows.filter((r) => r.status === 'done');
  const abandoned = rows.filter((r) => r.status === 'abandoned');
  const totalSec = rows.reduce((sum, r) => {
    const end = r.ended_at ?? Date.now();
    return sum + Math.max(0, Math.round((end - r.started_at) / 1000));
  }, 0);
  const plannedSec = rows.reduce((sum, r) => sum + r.planned_min * 60, 0);
  return {
    started: rows.length,
    completed: completed.length,
    abandoned: abandoned.length,
    running: rows.filter((r) => r.status === 'running').length,
    total_sec: totalSec,
    planned_sec: plannedSec,
    interruptions: rows.reduce((sum, r) => sum + r.interruptions, 0),
    completion_rate: rows.length ? Number((completed.length / rows.length).toFixed(2)) : null,
  };
}

function taskStats(day) {
  const [start, end] = dayRange(day);
  const done = all(
    'SELECT id, title, estimate_min, completed_at FROM tasks WHERE completed_at >= ? AND completed_at < ?',
    start, end,
  );
  const created = get(
    'SELECT COUNT(*) AS n FROM tasks WHERE created_at >= ? AND created_at < ?',
    start, end,
  ).n;
  const open = get("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('todo','doing')").n;
  const overdue = get(
    "SELECT COUNT(*) AS n FROM tasks WHERE status IN ('todo','doing') AND due_at IS NOT NULL AND due_at < ?",
    Date.now(),
  ).n;

  // "오늘 하기로 한 일" — 계획과 실제를 나란히 두기 위한 것.
  const planned = all(
    'SELECT id, title, status, estimate_min FROM tasks WHERE planned_for = ? ORDER BY sort_order',
    day,
  );

  return {
    completed: done.length,
    created,
    open,
    overdue,
    completed_tasks: done,
    planned: planned.length,
    planned_done: planned.filter((t) => t.status === 'done').length,
    planned_min: planned.reduce((s, t) => s + (t.estimate_min || 0), 0),
    planned_tasks: planned,
  };
}

/**
 * Cadence 점수 (0~100). 하루를 한 숫자로 요약한다.
 * 가중치는 "얼마나 오래 앉아 있었나"가 아니라 "얼마나 온전한 시간을 만들었나"에 둔다.
 */
export function cadenceScore({ kinds, blocks, focus, switchesPerHour, activeSec }) {
  const deepSec = kinds.deep || 0;
  const target = conf('daily_deep_target_min') * 60;

  // 표본이 너무 적으면 점수를 매기지 않는다 — 기록이 없는 날에 "파편화 만점"이
  // 붙어 점수가 부풀려지는 것을 막는다.
  if (activeSec < 300) {
    return {
      total: 0,
      insufficient: true,
      unreliable: false,
      unclassified_ratio: 0,
      session_scored: false,
      parts: { deep: 0, continuity: 0, fragmentation: 0, distraction: 0, sessions: null },
    };
  }

  // 1) 몰입 시간 (40점)
  const deepScore = Math.min(1, deepSec / target) * 40;

  // 2) 몰입의 연속성 (20점) — 같은 시간이라도 블록으로 뭉쳐 있을수록 높다.
  const blockSec = blocks.reduce((s, b) => s + b.deep_sec, 0);
  // 블록 안의 몰입이 하루 전체 몰입보다 클 수는 없다(같은 세그먼트에서 나오므로).
  // 그래도 1 로 묶어 둔다 — 어긋난 값이 들어오면 점수가 100 을 넘어 화면이 대놓고 틀려 보인다.
  const continuity = deepSec > 0 ? Math.min(1, blockSec / deepSec) : 0;
  const continuityScore = continuity * 20;

  // 3) 파편화 (15점) — 시간당 앱 전환이 적을수록 높다. 30회/시간에서 0점이 된다.
  const fragScore = Math.max(0, 1 - Math.min(switchesPerHour, 30) / 30) * 15;

  // 4) 방해 비율 (15점)
  const distraction = kinds.distraction || 0;
  const ratio = activeSec > 0 ? distraction / activeSec : 0;
  const distractionScore = Math.max(0, 1 - ratio * 4) * 15;

  // 5) 집중 세션 이행 (10점)
  const sessionScore = (focus.completion_rate ?? 0)
    * Math.min(1, focus.started / Math.max(1, conf('daily_focus_target'))) * 10;

  const observed = deepScore + continuityScore + fragScore + distractionScore;

  // 세션을 아예 쓰지 않은 날은 이 항목을 빼고 나머지를 100점 만점으로 환산한다.
  //
  // 점수는 "일이 어떻게 흘렀는가"를 재는 것이지 "도구를 규칙대로 썼는가"를 재는 것이 아니다.
  // 자동 추적만 쓰는 사람에게 매일 10점을 깎으면, 점수가 그 사람의 하루를 설명하지 못하고
  // 계속 낮게만 나와 아무 쓸모가 없어진다. 세션을 한 번이라도 시작했다면 그때부터는
  // 이행 여부를 함께 본다 — 시작해 놓고 중간에 놓는 것은 그 자체로 파편화의 신호이므로.
  const usesSessions = focus.started > 0;
  const total = usesSessions ? observed + sessionScore : (observed / 90) * 100;

  // 미분류가 절반을 넘으면 이 점수는 하루가 아니라 **분류 상태**를 재고 있는 셈이다.
  //
  // 미분류 시간은 몰입에도 방해에도 들어가지 않으므로, 분류를 안 한 사람은 무엇을 하든
  // 낮은 점수를 받는다. 그 숫자를 그대로 크게 띄우면 사람은 자기 하루가 나빴다고 읽는다.
  // 값은 그대로 두되 "믿을 만한 값이 아니다" 라고 함께 말한다.
  const unclassified = kinds.other || 0;
  const unreliable = activeSec > 0 && unclassified / activeSec > 0.5;

  return {
    total: Math.round(total),
    insufficient: false,
    unreliable,
    unclassified_ratio: activeSec > 0 ? Number((unclassified / activeSec).toFixed(3)) : 0,
    // 세션을 쓰지 않아 환산된 날인지 화면에서 설명할 수 있도록 남긴다.
    session_scored: usesSessions,
    parts: {
      deep: Math.round(deepScore),
      continuity: Math.round(continuityScore),
      fragmentation: Math.round(fragScore),
      distraction: Math.round(distractionScore),
      sessions: usesSessions ? Math.round(sessionScore) : null,
    },
  };
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 최근 기록된 날들의 기준선.
 *
 * "몰입 4시간 28분"이라는 숫자 하나로는 좋은 하루인지 알 수 없다. 자기 자신의 평소와
 * 비교해야 의미가 생긴다. 평균 대신 중앙값을 쓴다 — 하루 몰아친 날이나 반차 낸 날에
 * 기준선이 통째로 흔들리지 않도록.
 *
 * 세그먼트를 일일이 훑지 않고 집계 쿼리 한 번으로 끝낸다. 하루 리포트는 화면을 열 때마다
 * 불리므로 가벼워야 한다.
 */
export function baselineFor(day, { window = 14, minActiveSec = 1800 } = {}) {
  const from = shiftDay(day, -window);
  const rows = all(`
    SELECT a.day,
      SUM(CASE WHEN a.idle = 0 THEN a.seconds ELSE 0 END) AS active_sec,
      SUM(CASE WHEN a.idle = 0 AND c.kind = 'deep' THEN a.seconds ELSE 0 END) AS deep_sec,
      SUM(CASE WHEN a.idle = 0 AND c.kind = 'meeting' THEN a.seconds ELSE 0 END) AS meeting_sec,
      SUM(CASE WHEN a.idle = 0 AND c.kind = 'distraction' THEN a.seconds ELSE 0 END) AS distraction_sec
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day >= ? AND a.day < ?
    GROUP BY a.day
  `, from, day);

  const workdays = rows.filter((r) => r.active_sec >= minActiveSec);
  if (workdays.length < 3) return { days: workdays.length, enough: false };

  return {
    days: workdays.length,
    enough: true,
    window,
    active_sec: median(workdays.map((r) => r.active_sec)),
    deep_sec: median(workdays.map((r) => r.deep_sec)),
    meeting_sec: median(workdays.map((r) => r.meeting_sec)),
    distraction_sec: median(workdays.map((r) => r.distraction_sec)),
  };
}

export function dayReport(query = {}) {
  const day = dayString(query.day, 'day', dayKey());
  const segments = segmentsFor(day);
  const kinds = sumByKind(segments);
  const activeSec = segments.filter((s) => !s.idle).reduce((sum, s) => sum + s.seconds, 0);
  const blocks = deepBlocks(segments);
  const switches = switchCount(segments);
  const activeHours = activeSec / 3600;
  const switchesPerHour = activeHours > 0.05 ? Number((switches / activeHours).toFixed(1)) : 0;
  const focus = focusStats(day);
  const tasks = taskStats(day);
  const score = cadenceScore({ kinds, blocks, focus, switchesPerHour, activeSec });

  const topApps = all(`
    SELECT a.app, SUM(a.seconds) AS seconds
    FROM activity a WHERE a.day = ? AND a.idle = 0
    GROUP BY a.app ORDER BY seconds DESC LIMIT 8
  `, day);

  const byCategory = all(`
    SELECT COALESCE(c.name, '미분류') AS name, COALESCE(c.color, '#6b7280') AS color,
           COALESCE(c.kind, 'other') AS kind, SUM(a.seconds) AS seconds
    FROM activity a LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day = ? AND a.idle = 0
    GROUP BY c.id ORDER BY seconds DESC
  `, day);

  const firstLast = get(
    'SELECT MIN(started_at) AS first_at, MAX(ended_at) AS last_at FROM activity WHERE day = ? AND idle = 0',
    day,
  );

  return {
    day,
    score,
    /**
     * 정말 처음 켠 것인지.
     *
     * 화면은 "오늘이 비었는가" 로 첫 실행을 판단하고 있었다. 그러면 몇 달을 쓴 사람이
     * 하루 쉬고 온 날 아침에 "Cadence 를 시작합니다 — 첫 태스크 만들기" 가 뜬다.
     * 자기가 쌓아 온 것을 도구가 통째로 잊은 것처럼 보이는 화면이라, 그냥 어색한 것을
     * 넘어 불안하다. 오늘이 아니라 **기록 전체**를 봐야 답할 수 있는 질문이다.
     */
    first_run: !get('SELECT 1 AS x FROM activity LIMIT 1')
      && !get('SELECT 1 AS x FROM tasks LIMIT 1')
      && !get('SELECT 1 AS x FROM focus_sessions LIMIT 1'),
    active_sec: activeSec,
    idle_sec: kinds.idle || 0,
    span_sec: firstLast?.first_at ? Math.round((firstLast.last_at - firstLast.first_at) / 1000) : 0,
    first_at: firstLast?.first_at || null,
    last_at: firstLast?.last_at || null,
    kinds,
    by_category: byCategory,
    top_apps: topApps,
    deep_blocks: blocks,
    deep_block_sec: blocks.reduce((s, b) => s + b.deep_sec, 0),
    longest_block_sec: blocks.reduce((m, b) => Math.max(m, b.deep_sec), 0),
    switches,
    switches_per_hour: switchesPerHour,
    focus,
    tasks,
    hourly: hourlyDensity(day),
    baseline: baselineFor(day),
    // 최근 한 달치 추정 편향. 오늘 계획한 일이 실제로 몇 시간짜리인지 가늠하는 데 쓴다 —
    // 하루가 아직 고쳐질 수 있을 때 알아야 쓸모가 있으므로 하루 리포트에 함께 싣는다.
    estimate_bias: estimateBias(dayRange(shiftDay(day, -30))[0], dayRange(day)[1]),
    targets: {
      deep_min: conf('daily_deep_target_min'),
      focus_sessions: conf('daily_focus_target'),
      // 화면이 "15분 이상 연속 구간", "25분 집중 시작" 처럼 숫자를 문장에 박아 두고 있었다.
      // 설정에서 바꿀 수 있는 값인데도 글에는 옛 숫자가 그대로 남아, 40분으로 바꿔 둔
      // 사람에게는 화면이 **거짓말을 하는** 상태가 된다. 판정에 쓰는 값을 함께 내보낸다.
      block_min: conf('deep_block_min'),
      focus_min: Number(setting('default_focus_min', 25)) || 25,
    },
  };
}

/** 최근 n일 추세 — 대시보드 스파크라인용. */
export function trend(query = {}) {
  const days = int(query.days ?? 14, 'days', { min: 2, max: 120 });
  const keys = lastDays(days, dayString(query.day, 'day', dayKey()));
  return keys.map((day) => {
    const segments = segmentsFor(day);
    const kinds = sumByKind(segments);
    const activeSec = segments.filter((s) => !s.idle).reduce((sum, s) => sum + s.seconds, 0);
    const blocks = deepBlocks(segments);
    const switches = switchCount(segments);
    const activeHours = activeSec / 3600;
    const switchesPerHour = activeHours > 0.05 ? Number((switches / activeHours).toFixed(1)) : 0;
    const focus = focusStats(day);
    const score = cadenceScore({ kinds, blocks, focus, switchesPerHour, activeSec });
    const [start, end] = dayRange(day);
    return {
      day,
      score: score.total,
      // 미분류가 절반을 넘는 날의 점수는 하루가 아니라 분류 상태를 재고 있다.
      // 화면이 평균에서 빼거나 흐리게 그릴 수 있도록 함께 내보낸다 —
      // 하루 화면에서만 경고하고 추세에서 조용히 섞어 버리면 경고가 무의미해진다.
      unreliable: score.unreliable === true,
      unclassified_ratio: score.unclassified_ratio ?? 0,
      active_sec: activeSec,
      deep_sec: kinds.deep || 0,
      distraction_sec: kinds.distraction || 0,
      meeting_sec: kinds.meeting || 0,
      comms_sec: kinds.comms || 0,
      shallow_sec: kinds.shallow || 0,
      blocks: blocks.length,
      switches_per_hour: switchesPerHour,
      sessions: focus.completed,
      tasks_done: get(
        'SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?', start, end,
      ).n,
    };
  });
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

/**
 * 개인 업무 리듬.
 *
 * 여러 주에 걸친 기록을 시간대·요일로 접으면 "언제 몰입이 잘 되는가"가 드러난다.
 * 이건 하루치 기록으로는 절대 알 수 없고, 자동 추적이 쌓여야만 나오는 답이다.
 * 골든타임을 알면 회의를 어디에 몰아야 하는지도 정해진다.
 *
 * 절대 시간이 아니라 "그 시간대에 자리에 있었을 때 몰입했던 비율"로 본다 —
 * 단순 합계는 그냥 오래 앉아 있던 시간대를 가리킬 뿐이라서.
 */
export function rhythm(query = {}) {
  const weeks = int(query.weeks ?? 8, 'weeks', { min: 2, max: 52 });
  const to = dayString(query.day, 'day', dayKey());
  const from = shiftDay(to, -weeks * 7);

  const rows = all(`
    SELECT a.started_at, a.ended_at, a.seconds, a.idle, a.day,
           COALESCE(c.kind, 'other') AS kind
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day >= ? AND a.day <= ? AND a.idle = 0
  `, from, to);

  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour, deep_sec: 0, active_sec: 0, days: new Set(),
  }));
  const byWeekday = Array.from({ length: 7 }, (_, dow) => ({
    dow, label: WEEKDAYS[dow], deep_sec: 0, active_sec: 0, days: new Set(),
  }));

  for (const r of rows) {
    const isDeep = DEEP_KINDS.has(r.kind);
    // 시간 경계를 넘는 구간은 잘라서 각 시간대에 나눠 담는다.
    // 한 기록이 아무리 길어도 이틀치 시간대면 충분하다 — 시각이 망가진 행에 발이 묶이지 않도록.
    let cursor = r.started_at;
    let guard = 0;
    while (cursor < r.ended_at && guard++ < 48) {
      const d = new Date(cursor);
      const hourEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime();
      if (hourEnd <= cursor) break;
      const chunkEnd = Math.min(r.ended_at, hourEnd);
      const sec = Math.round((chunkEnd - cursor) / 1000);

      const hourBucket = byHour[d.getHours()];
      hourBucket.active_sec += sec;
      hourBucket.days.add(r.day);
      if (isDeep) hourBucket.deep_sec += sec;

      const dowBucket = byWeekday[d.getDay()];
      dowBucket.active_sec += sec;
      dowBucket.days.add(r.day);
      if (isDeep) dowBucket.deep_sec += sec;

      cursor = chunkEnd;
    }
  }

  const shapeBucket = (b) => {
    const days = b.days.size;
    return {
      ...b,
      days,
      deep_ratio: b.active_sec > 0 ? Number((b.deep_sec / b.active_sec).toFixed(3)) : null,
      deep_per_day: days ? Math.round(b.deep_sec / days) : 0,
      active_per_day: days ? Math.round(b.active_sec / days) : 0,
    };
  };

  const hours = byHour.map(shapeBucket);
  const weekdays = byWeekday.map(shapeBucket);

  // 골든타임: 연속 두 시간짜리 창 중 몰입 비율이 가장 높은 구간.
  // 표본이 적은 시간대(관측일 3일 미만)는 후보에서 뺀다 — 어쩌다 한 번이 1등이 되지 않도록.
  const eligible = hours.filter((x) => x.days >= 3 && x.active_sec > 0);
  let best = null;
  let worst = null;
  for (let h = 0; h < 23; h++) {
    const a = hours[h];
    const b = hours[h + 1];
    if (a.days < 3 || b.days < 3) continue;
    const active = a.active_sec + b.active_sec;
    if (active < 1800) continue;
    const ratio = (a.deep_sec + b.deep_sec) / active;
    const window = {
      start_hour: h,
      end_hour: h + 2,
      deep_ratio: Number(ratio.toFixed(3)),
      deep_per_day: a.deep_per_day + b.deep_per_day,
      active_sec: active,
    };
    if (!best || ratio > best.deep_ratio) best = window;
    if (!worst || ratio < worst.deep_ratio) worst = window;
  }

  const bestDay = [...weekdays].filter((d) => d.days >= 2 && d.active_sec > 0)
    .sort((a, b) => b.deep_ratio - a.deep_ratio)[0] ?? null;
  const worstDay = [...weekdays].filter((d) => d.days >= 2 && d.active_sec > 0)
    .sort((a, b) => a.deep_ratio - b.deep_ratio)[0] ?? null;

  return {
    from,
    to,
    weeks,
    observed_days: new Set(rows.map((r) => r.day)).size,
    enough: eligible.length >= 3,
    hours: hours.map(({ days, ...rest }) => ({ ...rest, days })),
    weekdays: weekdays.map(({ days, ...rest }) => ({ ...rest, days })),
    best_window: best,
    worst_window: worst,
    best_weekday: bestDay,
    worst_weekday: worstDay,
  };
}

/**
 * 기간 내 프로젝트별 투입 시간.
 *
 * 두 갈래를 합친다.
 *  - 집중 세션 시간 (세션 → 태스크 → 프로젝트)
 *  - 태스크에 연결됐지만 세션 구간과 겹치지 않는 자동 추적 시간
 * 겹침을 배제해 같은 시간이 두 번 세어지지 않게 한다.
 * 목표(weekly_target_min)가 있는 프로젝트는 실적이 0이어도 목록에 남긴다 — 예산 비교를 위해.
 */
export function projectTime(from, to) {
  const rows = all(`
    SELECT p.id, p.name, p.color, p.weekly_target_min,
      (SELECT COALESCE(SUM(
          (CASE WHEN s.ended_at IS NULL THEN unixepoch() * 1000 ELSE s.ended_at END) - s.started_at
       ) / 1000, 0)
       FROM focus_sessions s
       JOIN tasks t ON t.id = s.task_id
       WHERE t.project_id = p.id AND s.kind = 'focus' AND s.status != 'abandoned'
         AND s.started_at >= ? AND s.started_at < ?) AS session_sec,

      (SELECT COALESCE(SUM(a.seconds), 0)
       FROM activity a
       JOIN tasks t2 ON t2.id = a.task_id
       WHERE t2.project_id = p.id AND a.idle = 0
         AND a.started_at >= ? AND a.started_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM focus_sessions s2
           WHERE s2.task_id = a.task_id
             AND a.started_at < COALESCE(s2.ended_at, 9007199254740991)
             AND a.ended_at   > s2.started_at
         )) AS tracked_sec
    FROM projects p
    WHERE p.archived = 0
  `, from, to, from, to);

  return rows
    .map((r) => {
      const seconds = (r.session_sec || 0) + (r.tracked_sec || 0);
      const targetSec = r.weekly_target_min ? r.weekly_target_min * 60 : null;
      return {
        id: r.id,
        name: r.name,
        color: r.color,
        seconds,
        session_sec: r.session_sec || 0,
        tracked_sec: r.tracked_sec || 0,
        target_sec: targetSec,
        ratio: targetSec ? Number((seconds / targetSec).toFixed(2)) : null,
      };
    })
    .filter((r) => r.seconds > 0 || r.target_sec)
    .sort((a, b) => b.seconds - a.seconds);
}

/**
 * 임의 기간 리포트.
 *
 * 주 단위 고정 리포트로는 "지난달 이 프로젝트에 몇 시간 썼나", "8월 12일~9월 3일 정산"
 * 같은 질문에 답할 수 없다. 프로젝트·태스크·카테고리를 같은 기준으로 합쳐 돌려준다.
 */
export function rangeReport(query = {}) {
  const to = dayString(query.to, 'to', dayKey());
  const from = dayString(query.from, 'from', shiftDay(to, -29));
  if (from > to) throw badRequest('from 이 to 보다 늦습니다');

  const [start] = dayRange(from);
  const [, end] = dayRange(to);

  const byCategory = all(`
    SELECT COALESCE(c.name, '미분류') AS name, COALESCE(c.color, '#6b7280') AS color,
           COALESCE(c.kind, 'other') AS kind, SUM(a.seconds) AS seconds
    FROM activity a LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day >= ? AND a.day <= ? AND a.idle = 0
    GROUP BY c.id ORDER BY seconds DESC
  `, from, to);

  // 태스크별 투입 시간 — 프로젝트 집계와 같은 규칙(세션 + 겹치지 않는 추적)을 쓴다.
  const byTask = all(`
    SELECT t.id, t.title, t.status, t.estimate_min,
           COALESCE(p.name, '(프로젝트 없음)') AS project_name,
           COALESCE(p.color, '#6b7280') AS project_color,
      (SELECT COALESCE(SUM(
          (CASE WHEN s.ended_at IS NULL THEN unixepoch() * 1000 ELSE s.ended_at END) - s.started_at
       ) / 1000, 0)
       FROM focus_sessions s
       WHERE s.task_id = t.id AND s.kind = 'focus' AND s.status != 'abandoned'
         AND s.started_at >= ? AND s.started_at < ?) AS session_sec,
      (SELECT COALESCE(SUM(a.seconds), 0)
       FROM activity a
       WHERE a.task_id = t.id AND a.idle = 0
         AND a.started_at >= ? AND a.started_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM focus_sessions s2
           WHERE s2.task_id = a.task_id
             AND a.started_at < COALESCE(s2.ended_at, 9007199254740991)
             AND a.ended_at   > s2.started_at
         )) AS tracked_sec
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id
  `, start, end, start, end)
    .map((r) => ({ ...r, seconds: (r.session_sec || 0) + (r.tracked_sec || 0) }))
    .filter((r) => r.seconds > 0)
    .sort((a, b) => b.seconds - a.seconds);

  const days = all(`
    SELECT a.day,
      SUM(CASE WHEN a.idle = 0 THEN a.seconds ELSE 0 END) AS active_sec,
      SUM(CASE WHEN a.idle = 0 AND c.kind = 'deep' THEN a.seconds ELSE 0 END) AS deep_sec
    FROM activity a LEFT JOIN categories c ON c.id = a.category_id
    WHERE a.day >= ? AND a.day <= ?
    GROUP BY a.day ORDER BY a.day
  `, from, to);

  const activeSec = byCategory.reduce((s, c) => s + c.seconds, 0);
  const workdays = days.filter((d) => d.active_sec >= 1800).length;

  return {
    from,
    to,
    days,
    workdays,
    active_sec: activeSec,
    deep_sec: byCategory.filter((c) => c.kind === 'deep').reduce((s, c) => s + c.seconds, 0),
    by_category: byCategory,
    by_project: projectTime(start, end),
    by_task: byTask,
    tasks_done: get(
      'SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?', start, end,
    ).n,
    sessions: get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(COALESCE(ended_at, unixepoch()*1000) - started_at) / 1000, 0) AS seconds
       FROM focus_sessions WHERE kind = 'focus' AND status != 'abandoned'
         AND started_at >= ? AND started_at < ?`, start, end,
    ),
  };
}

/** 주간 리포트 — 요일별 합계 + 추정 정확도 + 프로젝트 배분. */
/**
 * 추정 편향 — 완료한 태스크에서 "예상 대비 실제" 의 중앙값.
 *
 * 사람은 대개 자기 일에 걸리는 시간을 적게 잡는다. 그 버릇은 개인마다 꽤 일정해서,
 * 지난 기록의 중앙값을 곱하면 오늘의 계획이 실제로 몇 시간짜리인지 가늠할 수 있다.
 * 평균이 아니라 중앙값을 쓰는 것은, 한 번 크게 어긋난 태스크가 전체를 끌고 가지 않도록.
 */
/** 추정 편향을 "경향" 이라고 부르기 위한 최소 표본. 이보다 적으면 중앙값을 내지 않는다. */
const MIN_ESTIMATE_SAMPLES = 3;

export function estimateBias(fromMs, toMs) {
  // 투입 시간의 정의는 태스크 목록·프로젝트 집계·기간 리포트와 **똑같아야** 한다.
  // 여기만 "집중 세션 시간"으로 세면, 같은 태스크를 두 화면에서 볼 때 실제 시간이
  // 다르게 나온다 — 어느 쪽이 맞는지 사용자가 알 방법이 없다.
  // (test/task-time.test.mjs 가 네 경로의 값이 일치하는지 지킨다.)
  const estimates = all(`
    SELECT t.id, t.title, t.estimate_min,
      (SELECT COALESCE(SUM(
          (CASE WHEN s.ended_at IS NULL THEN unixepoch() * 1000 ELSE s.ended_at END) - s.started_at
       ) / 1000, 0)
       FROM focus_sessions s
       WHERE s.task_id = t.id AND s.kind = 'focus' AND s.status != 'abandoned') AS session_sec,
      (SELECT COALESCE(SUM(a.seconds), 0)
       FROM activity a
       WHERE a.task_id = t.id AND a.idle = 0
         AND NOT EXISTS (
           SELECT 1 FROM focus_sessions s2
           WHERE s2.task_id = a.task_id
             AND a.started_at < COALESCE(s2.ended_at, 9007199254740991)
             AND a.ended_at   > s2.started_at
         )) AS tracked_sec
    FROM tasks t
    WHERE t.completed_at >= ? AND t.completed_at < ? AND t.estimate_min IS NOT NULL
  `, fromMs, toMs);

  const items = estimates
    .map((e) => ({ ...e, actual_sec: (e.session_sec || 0) + (e.tracked_sec || 0) }))
    .filter((e) => e.actual_sec > 0)
    .map((e) => ({ ...e, ratio: Number((e.actual_sec / 60 / e.estimate_min).toFixed(2)) }));
  // 표본이 적으면 중앙값을 **내보내지 않는다.**
  //
  // 예전에는 언제나 값을 돌려주고 부르는 쪽마다 `samples >= 3` 을 다시 확인했다.
  // 화면 세 곳은 확인했지만 마크다운 내보내기는 빠져 있었고, 그래서 표본 한 개짜리
  // "중앙값 배율 1.75×" 가 주간보고에 그대로 실려 나갔다 — 하필 숫자가 가장
  // 무겁게 읽히는 자리다. 기준을 값 안으로 옮겨 부르는 쪽이 잊을 수 없게 한다.
  const enough = items.length >= MIN_ESTIMATE_SAMPLES;
  const median = enough
    ? items.map((r) => r.ratio).sort((a, b) => a - b)[Math.floor(items.length / 2)]
    : null;

  return { samples: items.length, enough, median_ratio: median, items };
}

export function weekReport(query = {}) {
  const anchor = dayString(query.day, 'day', dayKey());
  const days = weekOf(anchor);
  const daily = days.map((day) => {
    const segments = segmentsFor(day);
    const kinds = sumByKind(segments);
    const blocks = deepBlocks(segments);
    return {
      day,
      active_sec: segments.filter((s) => !s.idle).reduce((sum, s) => sum + s.seconds, 0),
      deep_sec: kinds.deep || 0,
      block_sec: blocks.reduce((s, b) => s + b.deep_sec, 0),
      distraction_sec: kinds.distraction || 0,
      meeting_sec: kinds.meeting || 0,
      other_sec: kinds.other || 0,
    };
  });

  const [weekStart] = dayRange(days[0]);
  const [, weekEnd] = dayRange(days[6]);

  const byProject = projectTime(weekStart, weekEnd);

  const accuracy = estimateBias(weekStart, weekEnd);

  // 지난주와의 비교 — 주간 리뷰에서 "나아지고 있는가"를 판단할 수 있게.
  //
  // 주중에 열면 이번 주는 아직 며칠뿐이다. 지난주 7일과 통째로 견주면 늘 "크게 줄었다"로
  // 나와 쓸모가 없으므로, 지난주도 같은 일수만 잘라서 비교한다.
  const today = dayKey();
  const elapsed = days.filter((d) => d <= today).length || 7;
  const prevWeek = weekOf(shiftDay(days[0], -1));
  const prevDays = prevWeek.slice(0, elapsed);
  const prevDaily = prevDays.map((day) => {
    const segments = segmentsFor(day);
    const kinds = sumByKind(segments);
    const blocks = deepBlocks(segments);
    return {
      active_sec: segments.filter((s) => !s.idle).reduce((sum, s) => sum + s.seconds, 0),
      deep_sec: kinds.deep || 0,
      block_sec: blocks.reduce((s, b) => s + b.deep_sec, 0),
      meeting_sec: kinds.meeting || 0,
      distraction_sec: kinds.distraction || 0,
    };
  });
  const [prevStart] = dayRange(prevDays[0]);
  const [, prevEnd] = dayRange(prevDays[prevDays.length - 1]);
  const sum = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

  return {
    days,
    daily,
    elapsed_days: elapsed,
    complete: elapsed >= 7,
    previous: {
      days: prevDays,
      compared_days: prevDays.length,
      active_sec: sum(prevDaily, 'active_sec'),
      deep_sec: sum(prevDaily, 'deep_sec'),
      block_sec: sum(prevDaily, 'block_sec'),
      meeting_sec: sum(prevDaily, 'meeting_sec'),
      distraction_sec: sum(prevDaily, 'distraction_sec'),
      tasks_done: get(
        'SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?', prevStart, prevEnd,
      ).n,
    },
    totals: {
      active_sec: daily.reduce((s, d) => s + d.active_sec, 0),
      deep_sec: daily.reduce((s, d) => s + d.deep_sec, 0),
      block_sec: daily.reduce((s, d) => s + d.block_sec, 0),
      distraction_sec: daily.reduce((s, d) => s + d.distraction_sec, 0),
      meeting_sec: daily.reduce((s, d) => s + d.meeting_sec, 0),
      // 미분류가 많으면 위의 몰입·방해 합계가 통째로 실제보다 작다.
      // 주간 리포트는 남이 읽는 자리이므로 그 사실을 함께 실어 보낸다.
      other_sec: daily.reduce((s, d) => s + d.other_sec, 0),
      tasks_done: get(
        'SELECT COUNT(*) AS n FROM tasks WHERE completed_at >= ? AND completed_at < ?', weekStart, weekEnd,
      ).n,
    },
    by_project: byProject,
    estimate_accuracy: accuracy,
  };
}
