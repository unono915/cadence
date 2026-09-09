import { all, get, run, tx, setting, setSetting } from '../lib/db.mjs';
import { badRequest } from '../lib/http.mjs';
import { str, dayString, int, oneOf } from '../lib/validate.mjs';
import { dayKey, humanDuration, hhmm, setDayStartHour, getDayStartHour } from '../lib/time.mjs';
import { dayReport, weekReport, rangeReport } from './analytics.mjs';
import { tracker } from '../tracker/tracker.mjs';
import { TRACKER_POLL_MS, IDLE_THRESHOLD_S } from '../lib/config.mjs';
import { LIMITS } from '../../web/lib/limits.js';

// ---- 일일 노트 ----

export function getNote(query = {}) {
  const day = dayString(query.day, 'day', dayKey());
  const row = get('SELECT * FROM notes WHERE day = ?', day);
  return row || { day, body: '', updated_at: null };
}

export function putNote(body) {
  const day = dayString(body.day, 'day', dayKey());
  const text = str(body.body, 'body', { max: LIMITS.DAY_NOTE, trim: false });
  run(
    `INSERT INTO notes(day, body, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(day) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at`,
    day, text, Date.now(),
  );
  return getNote({ day });
}

/** 흐름을 끊지 않기 위한 빠른 캡처 — 오늘 노트 맨 아래에 타임스탬프와 함께 덧붙인다. */
export function appendNote(body) {
  const day = dayString(body.day, 'day', dayKey());
  const line = str(body.text, 'text', { min: 1, max: LIMITS.NOTE_LINE });
  const current = getNote({ day }).body;
  const stamped = `- ${hhmm(Date.now())} ${line}`;
  const next = current ? `${current.replace(/\s+$/, '')}\n${stamped}\n` : `${stamped}\n`;
  return putNote({ day, body: next });
}

// ---- 설정 ----

/** 허용된 설정 키와 파서. 임의 키를 저장하지 않는다. */
export const SETTING_SPEC = {
  capture_titles: (v) => (v ? '1' : '0'),
  tracker_autostart: (v) => (v ? '1' : '0'),
  day_start_hour: (v) => String(int(v, 'day_start_hour', { min: 0, max: 23 })),
  analytics_deep_block_min: (v) => String(int(v, 'deep_block_min', { min: 5, max: 120 })),
  analytics_deep_tolerance_sec: (v) => String(int(v, 'deep_tolerance_sec', { min: 30, max: 900 })),
  analytics_gap_break_sec: (v) => String(int(v, 'gap_break_sec', { min: 60, max: 3600 })),
  analytics_daily_deep_target_min: (v) => String(int(v, 'daily_deep_target_min', { min: 30, max: 720 })),
  analytics_daily_focus_target: (v) => String(int(v, 'daily_focus_target', { min: 1, max: 24 })),
  tracker_poll_ms: (v) => String(int(v, 'tracker_poll_ms', { min: 2000, max: 30_000 })),
  tracker_idle_s: (v) => String(int(v, 'tracker_idle_s', { min: 30, max: 1800 })),
  notify_sound: (v) => (v ? '1' : '0'),
  default_focus_min: (v) => String(int(v, 'default_focus_min', { min: 5, max: 180 })),
  default_break_min: (v) => String(int(v, 'default_break_min', { min: 1, max: 60 })),
  theme: (v) => oneOf(v, 'theme', ['auto', 'light', 'dark']),
  // 마지막으로 주간 리뷰를 마친 주(그 주 월요일의 날짜). 리뷰 안내를 한 번만 띄우기 위한 것.
  last_weekly_review: (v) => (v === null || v === '' ? '' : dayString(v, 'last_weekly_review')),
  // 마지막으로 하루 마무리를 한 날.
  last_day_review: (v) => (v === null || v === '' ? '' : dayString(v, 'last_day_review')),
  day_review_hour: (v) => String(int(v, 'day_review_hour', { min: 0, max: 23 })),
  day_review_reminder: (v) => (v ? '1' : '0'),
  // 집중 세션 중에 방해요소로 샌 지 몇 초가 지나면 알릴지. 0 이면 알리지 않는다.
  drift_alert_s: (v) => String(int(v, 'drift_alert_s', { min: 0, max: 1800 })),
};

export const SETTING_DEFAULTS = {
  capture_titles: '1',
  tracker_autostart: '1',
  day_start_hour: '4',
  analytics_deep_block_min: '15',
  analytics_deep_tolerance_sec: '120',
  analytics_gap_break_sec: '300',
  analytics_daily_deep_target_min: '180',
  analytics_daily_focus_target: '6',
  tracker_poll_ms: String(TRACKER_POLL_MS),
  tracker_idle_s: String(IDLE_THRESHOLD_S),
  notify_sound: '1',
  default_focus_min: '25',
  default_break_min: '5',
  theme: 'auto',
  last_weekly_review: '',
  last_day_review: '',
  day_review_hour: '18',
  day_review_reminder: '1',
  drift_alert_s: '120',
};

export function getSettings() {
  const out = { ...SETTING_DEFAULTS };
  for (const row of all('SELECT key, value FROM settings')) {
    if (row.key in SETTING_DEFAULTS) out[row.key] = row.value;
  }
  return out;
}

/**
 * 업무일 경계가 바뀌면 이미 쌓인 기록의 날짜를 다시 계산한다.
 *
 * activity.day 와 focus_sessions.day 는 기록될 때의 시작 시각으로 고정된다.
 * 그래서 시작 시각을 04시에서 06시로 바꾸면, 어제까지의 기록은 04시 기준으로,
 * 오늘부터는 06시 기준으로 묶인다 — 한 화면 안에서 '하루'의 뜻이 두 개가 되는데
 * 숫자는 멀쩡해 보여서 아무도 눈치채지 못한다. 그래서 바꾸는 즉시 전부 다시 매긴다.
 *
 * 계산은 SQL 이 아니라 dayKey() 로 한다. 서머타임 경계에서 SQL 의 'localtime' 변환과
 * 자바스크립트의 날짜 계산이 한 시간 어긋날 수 있어서, 기준을 하나로 두는 편이 안전하다.
 *
 * 노트와 태스크의 planned_for 는 건드리지 않는다 — 그건 사람이 "이 날"이라고 적은 것이지
 * 기록에서 계산해 낸 값이 아니다.
 */
export function rebuildDayKeys() {
  let changed = 0;
  tx(() => {
    for (const table of ['activity', 'focus_sessions']) {
      for (const row of all(`SELECT id, started_at, day FROM ${table}`)) {
        const key = dayKey(row.started_at);
        if (key === row.day) continue;
        run(`UPDATE ${table} SET day = ? WHERE id = ?`, key, row.id);
        changed++;
      }
    }
  });
  return changed;
}

export function patchSettings(body) {
  const beforeDayStart = setting('day_start_hour', '4');

  for (const [key, value] of Object.entries(body)) {
    const parse = SETTING_SPEC[key];
    if (!parse) throw badRequest(`알 수 없는 설정 항목: ${key}`);
    setSetting(key, parse(value));
  }
  applyRuntimeSettings();

  if (setting('day_start_hour', '4') !== beforeDayStart) rebuildDayKeys();

  return getSettings();
}

/** 설정 중 런타임에 즉시 반영해야 하는 것들. */
export function applyRuntimeSettings() {
  setDayStartHour(Number(setting('day_start_hour', '4')));
  // 추적기는 자기 설정을 스스로 읽어 가고, 폴링 주기가 바뀌면 프로브를 다시 띄운다.
  tracker.applySettings({
    pollMs: Number(setting('tracker_poll_ms', String(TRACKER_POLL_MS))),
    idleThresholdS: Number(setting('tracker_idle_s', String(IDLE_THRESHOLD_S))),
  });
}

export function runtimeInfo() {
  return { day_start_hour: getDayStartHour(), today: dayKey() };
}

// ---- 내보내기 ----

function fmt(sec) {
  return humanDuration(sec);
}

/** 리포트에 곁들일 세션 목록 (메모 포함). */
function sessionsOf(day) {
  return all(`
    SELECT s.started_at, s.ended_at, s.kind, s.note, COALESCE(t.title, '') AS task_title
    FROM focus_sessions s
    LEFT JOIN tasks t ON t.id = s.task_id
    WHERE s.day = ?
    ORDER BY s.started_at ASC
  `, day);
}

/** 하루를 마무리하며 붙여 넣을 수 있는 마크다운 요약. */
export function dayMarkdown(query = {}) {
  const r = dayReport(query);
  const note = getNote({ day: r.day });
  const lines = [];

  lines.push(`# ${r.day} 업무 요약`);
  lines.push('');
  // 기록이 얕은 날의 0점은 "형편없었다"가 아니라 "잴 것이 없었다"이다.
  // 이 문서는 일지·주간보고에 그대로 붙는다 — 0 이라고 적어 두면 그렇게 읽힌다.
  const scoreText = r.score.insufficient ? 'Cadence 점수 —(기록 부족)' : `Cadence 점수 ${r.score.total}/100`;
  lines.push(`**${scoreText}** · 활동 ${fmt(r.active_sec)} · 몰입 ${fmt(r.kinds.deep || 0)} · 몰입 블록 ${r.deep_blocks.length}개`);
  // 이 문서는 일지·주간보고에 그대로 붙는다. 화면에서만 "믿을 값이 아니다" 라고 말하고
  // 내보낸 글에는 숫자만 남기면, 정작 남이 읽는 자리에서 경고가 사라진다.
  if (r.score.unreliable) {
    lines.push(`> 활동의 ${Math.round(r.score.unclassified_ratio * 100)}% 가 아직 분류되지 않아 위 점수와 몰입 시간은 실제보다 낮게 나옵니다.`);
  }
  if (r.first_at) lines.push(`업무 구간 ${hhmm(r.first_at)} – ${hhmm(r.last_at)} (총 ${fmt(r.span_sec)})`);
  if (r.baseline?.enough) {
    const diff = (r.kinds.deep || 0) - r.baseline.deep_sec;
    const sign = diff >= 0 ? '+' : '−';
    lines.push(`평소(최근 ${r.baseline.days}일 중앙값 ${fmt(r.baseline.deep_sec)}) 대비 몰입 ${sign}${fmt(Math.abs(diff))}`);
  }
  lines.push('');

  // 계획 대비 실적 — 보고할 때 가장 먼저 묻는 것이므로 위에 둔다.
  if (r.tasks.planned) {
    lines.push('## 오늘 하기로 한 일');
    for (const t of r.tasks.planned_tasks) {
      lines.push(`- [${t.status === 'done' ? 'x' : ' '}] ${t.title}${t.estimate_min ? ` (예상 ${t.estimate_min}분)` : ''}`);
    }
    lines.push(`→ ${r.tasks.planned_done}/${r.tasks.planned} 완료`);
    lines.push('');
  }

  // 빈 제목만 남은 절은 붙여 넣었을 때 지저분하다. 내용이 있을 때만 낸다.
  if (r.by_category.length) {
    lines.push('## 시간 배분');
    for (const c of r.by_category) {
      const pct = r.active_sec ? Math.round((c.seconds / r.active_sec) * 100) : 0;
      lines.push(`- ${c.name}: ${fmt(c.seconds)} (${pct}%)`);
    }
    lines.push('');
  }

  if (r.deep_blocks.length) {
    lines.push('## 몰입 블록');
    for (const b of r.deep_blocks) {
      lines.push(`- ${hhmm(b.start)}–${hhmm(b.end)} · ${fmt(b.deep_sec)} · ${b.top_app}`);
    }
    lines.push('');
  }

  lines.push('## 집중 세션');
  lines.push(`- 시작 ${r.focus.started} / 완료 ${r.focus.completed} / 중단 ${r.focus.abandoned} · 총 ${fmt(r.focus.total_sec)} · 방해 ${r.focus.interruptions}회`);
  for (const s of sessionsOf(r.day)) {
    if (s.kind === 'break') continue;
    const label = [s.task_title, s.note].filter(Boolean).join(' — ');
    lines.push(`  - ${hhmm(s.started_at)} · ${fmt(Math.round(((s.ended_at ?? Date.now()) - s.started_at) / 1000))}${label ? ` · ${label}` : ''}`);
  }
  lines.push('');

  lines.push('## 태스크');
  lines.push(`- 완료 ${r.tasks.completed}개 · 신규 ${r.tasks.created}개 · 미완 ${r.tasks.open}개${r.tasks.overdue ? ` · 기한 초과 ${r.tasks.overdue}개` : ''}`);
  for (const t of r.tasks.completed_tasks) lines.push(`  - [x] ${t.title}`);
  lines.push('');

  lines.push('## 지표');
  lines.push(`- 앱 전환: 시간당 ${r.switches_per_hour}회 (총 ${r.switches}회)`);
  lines.push(`- 가장 긴 몰입: ${fmt(r.longest_block_sec)}`);
  lines.push(`- 자리비움: ${fmt(r.idle_sec)}`);
  lines.push('');

  if (note.body.trim()) {
    lines.push('## 메모');
    lines.push(note.body.trim());
    lines.push('');
  }

  return lines.join('\n');
}

export function weekMarkdown(query = {}) {
  const r = weekReport(query);
  const lines = [];
  lines.push(`# 주간 리포트 (${r.days[0]} – ${r.days[6]})`);
  lines.push('');
  if (!r.complete) {
    lines.push(`> 이번 주는 아직 ${r.elapsed_days}일째입니다. 지난주 비교는 같은 ${r.previous.compared_days}일과 맞췄습니다.`);
    lines.push('');
  }
  lines.push(`활동 ${fmt(r.totals.active_sec)} · 몰입 ${fmt(r.totals.deep_sec)} · 몰입 블록 ${fmt(r.totals.block_sec)} · 회의 ${fmt(r.totals.meeting_sec)} · 완료 태스크 ${r.totals.tasks_done}개`);
  // 미분류가 3할을 넘으면 위 숫자들이 통째로 실제보다 작다. 주간 리포트는 남이 읽는
  // 자리이고, 붙여 넣고 나면 화면의 경고는 따라가지 않는다.
  if (r.totals.active_sec > 0 && r.totals.other_sec / r.totals.active_sec > 0.3) {
    const pct = Math.round((r.totals.other_sec / r.totals.active_sec) * 100);
    lines.push(`> 활동의 ${pct}%(${fmt(r.totals.other_sec)})가 아직 분류되지 않았습니다. 위 몰입·회의 시간은 그만큼 실제보다 작습니다.`);
  }
  lines.push('');

  // 지난주 대비 — 주간 보고에서 실제로 읽히는 건 이 줄이다.
  const p = r.previous;
  const trendLine = (label, now, before) => {
    if (!before) return `- ${label}: ${fmt(now)} (지난주 기록 없음)`;
    const diff = now - before;
    const sign = diff >= 0 ? '+' : '−';
    return `- ${label}: ${fmt(now)} — 지난주 ${fmt(before)} 대비 ${sign}${fmt(Math.abs(diff))}`;
  };
  lines.push('## 지난주 대비');
  lines.push(trendLine('몰입', r.totals.deep_sec, p.deep_sec));
  lines.push(trendLine('몰입 블록', r.totals.block_sec, p.block_sec));
  lines.push(trendLine('회의', r.totals.meeting_sec, p.meeting_sec));
  lines.push(trendLine('방해요소', r.totals.distraction_sec, p.distraction_sec));
  lines.push(`- 완료 태스크: ${r.totals.tasks_done}개 (지난주 ${p.tasks_done}개)`);
  lines.push('');

  lines.push('## 일별');
  lines.push('| 날짜 | 활동 | 몰입 | 블록 | 방해 |');
  lines.push('| --- | --- | --- | --- | --- |');
  // 아직 오지 않은 날까지 0 으로 채우면 보고서가 지저분해진다.
  const upto = dayKey();
  for (const d of r.daily) {
    if (d.day > upto) continue;
    lines.push(`| ${d.day} | ${fmt(d.active_sec)} | ${fmt(d.deep_sec)} | ${fmt(d.block_sec)} | ${fmt(d.distraction_sec)} |`);
  }
  lines.push('');
  if (r.by_project.length) {
    lines.push('## 프로젝트별');
    for (const proj of r.by_project) {
      const target = proj.target_sec
        ? ` — 목표 ${fmt(proj.target_sec)}의 ${Math.round(proj.ratio * 100)}%`
        : '';
      lines.push(`- ${proj.name}: ${fmt(proj.seconds)}${target}`);
    }
    lines.push('');
  }
  const acc = r.estimate_accuracy;
  if (acc.samples) {
    lines.push('## 추정 정확도');
    // 표본이 적으면 배율을 적지 않는다. 이 문서는 주간보고에 그대로 붙는데,
    // 한 건짜리 "중앙값 배율 1.75×" 는 근거처럼 읽히면서 근거가 아니다.
    lines.push(acc.enough
      ? `- 표본 ${acc.samples}개, 중앙값 배율 ${acc.median_ratio}× (1.0 이면 추정과 실제가 일치)`
      : `- 표본 ${acc.samples}개 — 아직 경향이라고 부르기 이릅니다 (3개부터 중앙값을 냅니다)`);
    for (const i of acc.items) {
      lines.push(`  - ${i.title}: 추정 ${i.estimate_min}분 → 실제 ${Math.round(i.actual_sec / 60)}분 (${i.ratio}×)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 임의 기간 리포트 (마크다운).
 * 정산·월간보고처럼 "기간을 정해서 근거를 대야 하는" 자리에 그대로 붙일 수 있게 만든다.
 */
export function rangeMarkdown(query = {}) {
  const r = rangeReport(query);
  const lines = [];

  lines.push(`# 기간 리포트 (${r.from} – ${r.to})`);
  lines.push('');
  lines.push(`기록된 근무일 ${r.workdays}일 · 활동 ${fmt(r.active_sec)} · 몰입 ${fmt(r.deep_sec)} · 완료 태스크 ${r.tasks_done}개`);
  if (r.workdays) lines.push(`하루 평균 활동 ${fmt(r.active_sec / r.workdays)} · 하루 평균 몰입 ${fmt(r.deep_sec / r.workdays)}`);
  lines.push('');

  if (r.by_project.length) {
    lines.push('## 프로젝트별');
    const linked = r.by_project.reduce((s, p) => s + p.seconds, 0);
    // 비중은 **프로젝트에 연결된 시간** 안에서의 몫이다. 위에 적힌 활동 시간과 나란히 두면
    // "나머지는 어디 갔나" 로 읽히므로, 무엇을 100 으로 놓고 센 값인지 먼저 밝힌다.
    // 이 문서는 정산·월간보고에 그대로 붙는 자리라 그 오해가 특히 비싸다.
    lines.push(`프로젝트에 연결된 시간 ${fmt(linked)}`
      + (r.active_sec ? ` — 활동의 ${Math.round((linked / r.active_sec) * 100)}%` : '')
      + '. 아래 비중은 이 시간을 100 으로 놓은 값입니다.');
    lines.push('');
    lines.push('| 프로젝트 | 시간 | 비중 |');
    lines.push('| --- | --- | --- |');
    const total = linked || 1;
    for (const p of r.by_project) {
      lines.push(`| ${p.name} | ${fmt(p.seconds)} | ${Math.round((p.seconds / total) * 100)}% |`);
    }
    lines.push('');
  }

  if (r.by_task.length) {
    lines.push('## 태스크별');
    lines.push('| 태스크 | 프로젝트 | 시간 | 상태 |');
    lines.push('| --- | --- | --- | --- |');
    const STATUS = { todo: '할 일', doing: '진행 중', done: '완료', archived: '보관' };
    for (const t of r.by_task) {
      lines.push(`| ${t.title} | ${t.project_name} | ${fmt(t.seconds)} | ${STATUS[t.status] || t.status} |`);
    }
    lines.push('');
  }

  lines.push('## 카테고리별');
  for (const c of r.by_category) {
    const pct = r.active_sec ? Math.round((c.seconds / r.active_sec) * 100) : 0;
    lines.push(`- ${c.name}: ${fmt(c.seconds)} (${pct}%)`);
  }
  lines.push('');

  return lines.join('\n');
}

/** 태스크별 시간 CSV — 정산 자료로 쓰기 좋게 분 단위 숫자를 함께 넣는다. */
export function rangeTasksCsv(query = {}) {
  const r = rangeReport(query);
  const header = ['from', 'to', 'project', 'task', 'status', 'estimate_min', 'session_min', 'tracked_min', 'total_min'];
  const out = [header.join(',')];
  for (const t of r.by_task) {
    out.push([
      r.from, r.to, t.project_name, t.title, t.status,
      t.estimate_min ?? '',
      Math.round((t.session_sec || 0) / 60),
      Math.round((t.tracked_sec || 0) / 60),
      Math.round(t.seconds / 60),
    ].map(csvCell).join(','));
  }
  return out.join('\n');
}

/**
 * CSV 한 칸.
 *
 * 따옴표·쉼표·줄바꿈을 감싸는 것 말고도 **수식 주입**을 막아야 한다.
 * 이 파일에는 다른 프로그램이 정한 창 제목이 그대로 들어간다. 제목이 `=` 나 `@` 로
 * 시작하면 엑셀은 그것을 수식으로 읽는다 — `=cmd|'/c ...'!A1` 같은 것은 실행까지 간다.
 * 파일을 여는 것은 사용자이고, 그때는 이 도구가 개입할 수 없다.
 *
 * 그래서 위험한 글자로 시작하는 칸 앞에 작은따옴표를 붙여 "이건 글자다" 라고 못박는다.
 * 값이 한 글자 늘어나지만, 남의 창 제목이 내 엑셀에서 실행되는 것보다는 낫다.
 */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  if (FORMULA_START.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function activityCsv(query = {}) {
  const from = dayString(query.from, 'from', dayKey());
  const to = dayString(query.to, 'to', from);
  const rows = all(`
    SELECT a.day, a.started_at, a.ended_at, a.seconds, a.app, a.title, a.idle,
           COALESCE(c.name, '') AS category, COALESCE(t.title, '') AS task
    FROM activity a
    LEFT JOIN categories c ON c.id = a.category_id
    LEFT JOIN tasks t ON t.id = a.task_id
    WHERE a.day >= ? AND a.day <= ?
    ORDER BY a.started_at ASC
  `, from, to);

  const header = ['day', 'start', 'end', 'seconds', 'app', 'title', 'idle', 'category', 'task'];
  const out = [header.join(',')];
  for (const r of rows) {
    out.push([
      r.day,
      new Date(r.started_at).toISOString(),
      new Date(r.ended_at).toISOString(),
      r.seconds,
      r.app,
      r.title,
      r.idle,
      r.category,
      r.task,
    ].map(csvCell).join(','));
  }
  return out.join('\n');
}

/** 전체 데이터 JSON 백업 — 로컬 파일이므로 사용자가 언제든 가져갈 수 있어야 한다. */
/**
 * 전체 백업. 내보낸 시각을 남긴다.
 *
 * 자동 사본은 데이터베이스와 **같은 디스크**에 있다 — 디스크가 죽으면 함께 사라진다.
 * 진짜 백업은 이 파일을 다른 곳에 두는 것뿐인데, 그건 사용자가 기억해야 하는 일이고
 * 사람은 기억하지 않는다. 언제 마지막으로 챙겼는지 기록해 두고 설정 화면에서 말해 준다.
 * 잔소리를 하려는 게 아니라, "한 번도 없음" 과 "그저께" 는 완전히 다른 상태이기 때문이다.
 */
export function exportAll() {
  setSetting('last_export_at', Date.now());
  return {
    exported_at: new Date().toISOString(),
    version: 1,
    categories: all('SELECT * FROM categories'),
    rules: all('SELECT * FROM rules'),
    projects: all('SELECT * FROM projects'),
    tasks: all('SELECT * FROM tasks'),
    focus_sessions: all('SELECT * FROM focus_sessions'),
    notes: all('SELECT * FROM notes'),
    settings: all('SELECT * FROM settings'),
    activity: all('SELECT * FROM activity ORDER BY started_at'),
  };
}
