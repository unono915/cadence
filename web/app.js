import { h, mount } from './lib/dom.js';
import { api } from './lib/api.js';
import { toast } from './lib/ui.js';
import { clock, relativeDay, dur } from './lib/format.js';
import {
  store, subscribe, notify as notifyStore, loadBase, refreshTracker, refreshSession,
  setDay, moveDay, isToday, watchDayRollover,
} from './lib/store.js';
import { openQuickAdd } from './views/quick-add.js';
import { notify, setTitleTimer, requestNotifications, notificationState } from './lib/notify.js';
import { openPalette } from './views/palette.js';
import { driftAlert } from './lib/insights.js';

const VIEWS = [
  { id: 'today', title: '오늘', icon: '◐', key: '1', loader: () => import('./views/today.js') },
  { id: 'tasks', title: '태스크', icon: '☰', key: '2', loader: () => import('./views/tasks.js') },
  { id: 'timeline', title: '타임라인', icon: '⧗', key: '3', loader: () => import('./views/timeline.js') },
  { id: 'reports', title: '리포트', icon: '▤', key: '4', loader: () => import('./views/reports.js') },
  { id: 'settings', title: '설정', icon: '⚙', key: '5', loader: () => import('./views/settings.js') },
];

const content = document.getElementById('content');
const navEl = document.getElementById('nav');
const titleEl = document.getElementById('view-title');
const dayNavEl = document.getElementById('day-nav');
const focusBarEl = document.getElementById('focus-bar');
const chipEl = document.getElementById('tracker-chip');

let currentView = null;
let currentInstance = null;

function currentViewId() {
  const id = location.hash.replace(/^#\/?/, '').split('?')[0];
  return VIEWS.some((v) => v.id === id) ? id : 'today';
}

function renderNav() {
  const active = currentViewId();
  mount(navEl,
    VIEWS.map((v) => h('a', {
      href: `#/${v.id}`,
      class: v.id === active ? 'active' : '',
    },
      h('span', { style: { width: '16px', display: 'inline-block', textAlign: 'center' } }, v.icon),
      h('span', v.title),
      h('span.key', v.key),
    )),
  );
}

function renderDayNav() {
  const view = VIEWS.find((v) => v.id === currentViewId());
  const showsDay = ['today', 'timeline'].includes(view?.id);
  if (!showsDay) { mount(dayNavEl); return; }
  mount(dayNavEl,
    h('button.btn.ghost.sm', { onclick: () => moveDay(-1), title: '이전 날 (←)', 'aria-label': '이전 날' }, '‹'),
    h('span.date', relativeDay(store.day, store.today)),
    h('button.btn.ghost.sm', {
      onclick: () => moveDay(1), disabled: isToday(), title: '다음 날 (→)', 'aria-label': '다음 날',
    }, '›'),
    isToday() ? null : h('button.btn.ghost.sm', { onclick: () => setDay(store.today) }, '오늘'),
  );
}

function renderTrackerChip() {
  const t = store.tracker || {};
  const cur = t.current;
  chipEl.className = `tracker-chip${t.running ? '' : ' off'}`;
  chipEl.title = t.supported
    ? (t.running ? '자동 추적 동작 중 — 클릭하면 일시정지' : '자동 추적 정지됨 — 클릭하면 시작')
    : '이 플랫폼에서는 자동 추적을 지원하지 않습니다';
  mount(chipEl,
    h('div.row', h('span.dot'), h('span', t.running ? '추적 중' : t.supported ? '정지됨' : '미지원')),
    cur ? h('div.now', `${cur.idle ? '자리비움' : cur.app} · ${dur(cur.seconds)}`) : null,
  );
  chipEl.onclick = async () => {
    if (!t.supported) { toast('자동 추적은 Windows 에서만 동작합니다'); return; }
    await api.post(t.running ? '/api/tracker/pause' : '/api/tracker/start');
    await refreshTracker();
    toast(t.running ? '자동 추적을 멈췄습니다' : '자동 추적을 시작했습니다', 'ok');
  };
}

/** 이미 "끝났습니다" 알림을 보낸 세션 id — 1초마다 반복 알림이 가지 않도록. */
const notified = new Set();

/**
 * 상단 바에서 매초 바뀌는 부분만 따로 들고 있는다.
 *
 * 타이머 때문에 1초마다 상단 바를 통째로 다시 그리면, 그 안의 버튼에 포커스를 둔 사람은
 * 매초 포커스를 잃는다 — 키보드로는 "방해" 버튼을 누를 수조차 없게 된다.
 * 그래서 구조는 세션이 바뀔 때만 만들고, 평소에는 숫자만 갈아 끼운다.
 */
let focusBarView = null;

function renderFocusBar() {
  const s = store.session;
  if (!s) {
    setTitleTimer(null);
    focusBarView = null;
    mount(focusBarEl,
      h('button.btn', { onclick: () => openQuickAdd('note') }, '＋ 메모'),
      h('button.btn.primary', { onclick: () => startFocus() }, '▶ 집중 시작'),
    );
    return;
  }
  const elapsed = Math.round((Date.now() - s.started_at) / 1000);
  const remaining = s.planned_min * 60 - elapsed;
  const over = remaining < 0;

  setTitleTimer(`${over ? '+' : ''}${clock(Math.abs(remaining))}`);

  if (remaining <= 0 && !notified.has(s.id)) {
    notified.add(s.id);
    const label = s.kind === 'break' ? '휴식이 끝났습니다' : '집중 시간이 끝났습니다';
    const detail = s.kind === 'break'
      ? '다시 시작할 준비가 됐다면 새 세션을 여세요.'
      : `${s.planned_min}분 ${s.task_title ? `— ${s.task_title}` : ''}`.trim();
    notify(label, detail, { silent: store.settings.notify_sound === '0' });
    toast(`${label} — 상단에서 종료하거나 이어서 진행하세요`, 'ok', 8000);
  }
  const label = s.task_title || (s.kind === 'break' ? '휴식' : '집중 세션');
  const text = over ? `+${clock(-remaining)}` : clock(remaining);

  // 같은 세션이 이어지는 동안에는 숫자만 갈아 끼운다.
  if (focusBarView && focusBarView.id === s.id) {
    focusBarView.timer.textContent = text;
    focusBarView.timer.className = `focus-timer${over ? ' over' : ''}`;
    if (focusBarView.label.textContent !== label) focusBarView.label.textContent = label;
    // 8할을 넘기는 순간 종료 버튼의 뜻이 바뀐다 — 그 한 번을 놓치면 버튼이 거짓말을 한다.
    focusBarView.paintEnd();
    return;
  }

  const timer = h(`div.focus-timer${over ? '.over' : ''}`, text);
  const taskLabel = h('div.focus-task.nowrap', label);

  /**
   * 종료 버튼은 **눌렀을 때 무엇으로 기록될지**를 미리 말한다.
   *
   * 계획의 8할을 못 채우고 끄면 중단으로 남는다. 버튼에 늘 "종료" 라고만 써 두면
   * 사용자는 자기가 무엇을 기록했는지 모른 채 완주율을 본다.
   * 기준 시각은 서버가 `done_at` 으로 알려 준다 — 화면에 다시 적으면 언젠가 갈라진다.
   */
  const endBtn = h('button.btn.sm.primary', { onclick: () => endCurrentSession() });
  const paintEnd = () => {
    const finished = Date.now() >= (s.done_at ?? 0);
    endBtn.textContent = finished ? '마치기' : '그만두기';
    endBtn.title = finished
      ? '계획한 만큼 채웠습니다 — 완주로 기록됩니다'
      : '계획한 시간을 채우기 전이라 중단으로 기록됩니다';
  };
  paintEnd();

  focusBarView = { id: s.id, timer, label: taskLabel, paintEnd };

  mount(focusBarEl,
    h('div', { style: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: '1.25' } },
      timer,
      taskLabel,
    ),
    h('button.btn.sm', {
      onclick: async () => { await api.post(`/api/sessions/${s.id}/interrupt`); toast('방해 1회 기록'); },
      title: '방해받았을 때 기록 (I)',
    }, '방해'),
    endBtn,
  );
}

/**
 * 세션 마감. 집중 세션을 계획한 시간 이상 채웠다면 휴식을 권한다 —
 * 쉬지 않고 이어 붙이는 것이 다음 블록을 망치는 가장 흔한 원인이라서.
 */
export async function endCurrentSession({ status } = {}) {
  const s = store.session;
  if (!s) return;
  // 상태를 넘기지 않으면 서버가 채운 시간을 보고 완주/중단을 정한다.
  // 여기서 다시 계산하면 두 곳의 기준이 언젠가 갈라진다 — 실제로 갈라져 있었다.
  const ended = await api.post(`/api/sessions/${s.id}/end`, status ? { status } : {});
  await refreshSession();
  notifyStore('session-end');

  const elapsed = Math.round((Date.now() - s.started_at) / 1000);
  const earned = s.kind === 'focus' && ended?.status === 'done';
  if (!earned) {
    toast(ended?.status === 'abandoned'
      ? `${clock(elapsed)} 만에 중단했습니다 — 완주로는 세지 않습니다`
      : '세션을 마쳤습니다', 'ok');
    return;
  }

  const breakMin = Number(store.settings.default_break_min || 5);
  const el = h('div.toast.ok', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
    h('span', `${clock(elapsed)} 집중 완료 — ${breakMin}분 쉴까요?`),
    h('button.btn.sm.primary', {
      onclick: async () => { el.remove(); await startBreak(breakMin); },
    }, '휴식 시작'),
    h('button.btn.sm.ghost', { onclick: () => el.remove() }, '아니요'),
  );
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 15_000);
}

export async function startFocus(taskId = null, minutes = null) {
  // 알림 권한은 사용자 동작 안에서만 물어볼 수 있다. 첫 세션을 시작하는 순간이 가장 자연스럽다.
  if (notificationState() === 'default') requestNotifications();
  const planned = minutes ?? Number(store.settings.default_focus_min || 25);
  await api.post('/api/sessions', { task_id: taskId, planned_min: planned, kind: 'focus' });
  await refreshSession();
  notifyStore('session-start');
  toast(`${planned}분 집중 세션을 시작했습니다`, 'ok');
}

export async function startBreak(minutes = null) {
  const planned = minutes ?? Number(store.settings.default_break_min || 5);
  await api.post('/api/sessions', { planned_min: planned, kind: 'break' });
  await refreshSession();
  notifyStore('session-start');
  toast(`${planned}분 휴식을 시작했습니다`, 'ok');
}

async function renderView() {
  const id = currentViewId();
  const view = VIEWS.find((v) => v.id === id);
  titleEl.textContent = view.title;
  setTitleTimer(null, view.title);
  if (store.session) renderFocusBar(); // 세션 중이면 제목을 다시 카운트다운으로
  renderNav();
  renderDayNav();

  if (currentView !== id) {
    currentInstance?.destroy?.();
    currentInstance = null;
    // 화면 낭독기에게 "지금 바뀌는 중"이라고 알린다. 그러지 않으면 로딩 중의 반쪽짜리
    // 내용을 읽어 버리거나, 다 바뀐 것을 눈치채지 못한다.
    content.setAttribute('aria-busy', 'true');
    mount(content, h('div.loading', '불러오는 중…'));

    const mod = await view.loader();
    // 그 사이에 사용자가 또 화면을 바꿨다면 이 화면은 이미 지난 것이다.
    if (currentViewId() !== id) return;

    // 화면마다 자기 컨테이너를 준다.
    //
    // 뷰들은 데이터를 받아 오는 동안(또는 디바운스된 검색이 뒤늦게 끝난 뒤) 자기 root 에
    // 다시 그린다. 모두가 같은 #content 를 쓰면, 화면을 빠르게 넘길 때 이전 화면의 늦은
    // 그리기가 새 화면을 덮어쓴다. 각자 별도 컨테이너를 쓰면 늦게 도착한 그리기는
    // 이미 떨어져 나간 요소에 그려져 아무 해도 끼치지 않는다.
    const viewRoot = h(`div.view#view-${id}`);
    mount(content, viewRoot);
    currentView = id;

    try {
      currentInstance = await mod.render(viewRoot);
    } catch (err) {
      // 한 번 실패했다고 빈 화면에 갇히면 안 된다. 무엇이 잘못됐는지 보여 주고 다시 시도할 길을 남긴다.
      console.error('[cadence] 화면을 그리지 못했습니다', err);
      currentInstance = null;
      currentView = null;
      mount(viewRoot, h('div.card',
        h('h2', '화면을 불러오지 못했습니다'),
        h('div.muted', { style: { fontSize: '13px', marginBottom: '12px' } },
          '서버가 내려갔거나 요청 하나가 실패했습니다. ',
          h('code', String(err?.message || err).slice(0, 200))),
        h('button.btn.primary', { onclick: () => renderView() }, '다시 시도'),
      ));
    } finally {
      content.setAttribute('aria-busy', 'false');
    }
  } else {
    try {
      await currentInstance?.refresh?.();
    } catch (err) {
      // 이미 그려진 화면이 있으므로 통째로 지우지 않는다 — 알림만 띄우고 그대로 둔다.
      console.error('[cadence] 새로 고치지 못했습니다', err);
    }
  }
}

/**
 * 세션 없이 몰입한 구간을 발견하면 한 번만 권한다.
 *
 * 집중 세션은 누르는 걸 잊기 쉬운 기록이다. 이미 추적기가 몰입 블록을 알고 있으므로
 * 뒤늦게라도 채워 넣을 기회를 준다. 다만 잔소리가 되면 안 되므로 같은 구간은 다시 묻지 않고,
 * 거절한 구간은 브라우저 세션 동안 기억한다.
 */
const DISMISSED_KEY = 'cadence.dismissedSuggestions';

function dismissedSuggestions() {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(DISMISSED_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function rememberDismissal(key) {
  try {
    const set = dismissedSuggestions();
    set.add(key);
    sessionStorage.setItem(DISMISSED_KEY, JSON.stringify([...set].slice(-40)));
  } catch { /* 저장이 막혀 있어도 동작에는 지장 없다 */ }
}

let suggestionShown = null;

async function checkSuggestion() {
  if (store.session) return;
  let s;
  try {
    s = await api.get('/api/sessions/suggest');
  } catch {
    return;
  }
  if (!s) return;

  const key = String(s.start);
  if (key === suggestionShown || dismissedSuggestions().has(key)) return;
  suggestionShown = key;

  const el = h('div.toast', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
    h('span',
      `세션 없이 ${s.minutes}분 몰입했습니다`,
      h('span.muted', { style: { display: 'block', fontSize: '11px' } },
        `${s.top_app}${s.task_title ? ` · ${s.task_title}` : ''} — 기록으로 남길까요?`),
    ),
    h('button.btn.sm.primary', {
      onclick: async () => {
        el.remove();
        await api.post('/api/sessions/record', { start: s.start, end: s.end, task_id: s.task_id });
        rememberDismissal(key);
        toast(`${s.minutes}분 세션을 기록했습니다`, 'ok');
        currentInstance?.refresh?.();
      },
    }, '기록'),
    h('button.btn.sm.ghost', {
      onclick: () => { el.remove(); rememberDismissal(key); },
    }, '아니요'),
  );
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 45_000);
}

/**
 * 집중 세션 중 이탈 알림.
 *
 * 이 도구는 여태 "끝난 뒤에" 알려 준다 — 리포트를 열어야 어제 어디로 샜는지 보인다.
 * 그런데 딴 데로 새는 순간에 정작 필요한 것은 기록이 아니라 **그 순간의 한마디**다.
 * 집중 세션을 걸어 둔 채로 방해요소에 오래 머물면, 그때 한 번만 조용히 알린다.
 *
 * 잔소리가 되지 않도록 규칙을 좁게 잡는다.
 *  - 집중 세션이 돌고 있을 때만 (휴식 중에는 유튜브를 봐도 된다)
 *  - 방해요소로 분류된 카테고리에 연속으로 머문 시간이 기준을 넘겼을 때만
 *  - 한 번 샌 동안에는 딱 한 번. 일로 돌아왔다가 다시 새면 그때 다시 말한다.
 *  - 설정에서 0 으로 두면 아예 끈다
 *
 * 화면이 아니라 알림으로 보내는 것이 핵심이다. 새고 있는 동안 Cadence 탭은
 * 뒤에 있으므로, 토스트만 띄우면 아무도 보지 못한다.
 */
let driftNudgedFor = null;

function checkDrift() {
  const s = store.session;
  const cur = store.tracker?.current;
  const hit = driftAlert({
    session: s,
    current: cur,
    thresholdS: Number(store.settings.drift_alert_s || 0),
  });

  if (!hit) {
    driftNudgedFor = null;
    return;
  }
  // 방해요소 사이를 옮겨 다니면 구간은 계속 새로 열린다. 구간마다 말을 걸면
  // 유튜브에서 인스타로 넘어갈 때마다 알림이 오는 셈이라 금세 잔소리가 된다.
  // 그래서 "이 이탈 동안 한 번"으로 묶는다 — 일로 돌아오면 저절로 풀린다.
  if (driftNudgedFor === s.id) return;
  driftNudgedFor = s.id;

  notify('집중 세션 중입니다',
    `${dur(hit.seconds)}째 ${hit.category.name}: ${hit.where}`,
    { silent: store.settings.notify_sound === '0' });

  const el = h('div.toast', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
    h('span', `${dur(hit.seconds)}째 ${hit.category.name}에 머물고 있습니다`,
      h('span.muted', { style: { display: 'block', fontSize: '11px' } },
        s.task_title ? `하던 일: ${s.task_title}` : '집중 세션이 아직 돌고 있습니다')),
    h('button.btn.sm', {
      onclick: async () => {
        el.remove();
        await api.post(`/api/sessions/${s.id}/interrupt`);
        toast('방해 1회 기록', 'ok');
      },
      title: '이번 이탈을 방해 횟수로 남깁니다',
    }, '방해로 기록'),
    h('button.btn.sm.ghost', { onclick: () => el.remove() }, '괜찮아요'),
  );
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 30_000);
}

/**
 * 하루 마무리 알림.
 *
 * 마무리는 알려주지 않으면 하지 않게 되는 습관이다. 다만 화면에 카드를 하나 더 붙이면
 * 잔소리가 되므로, 정해진 시각이 지났을 때 알림 하나만 띄우고 만다.
 * 하루에 한 번, 기록이 있고 아직 마무리하지 않은 날에만.
 */
const REVIEW_NUDGE_KEY = 'cadence.dayReviewNudged';

async function checkDayReview() {
  if (store.settings.day_review_reminder === '0') return;
  if (store.settings.last_day_review === store.today) return;

  const hour = Number(store.settings.day_review_hour || 18);
  if (new Date().getHours() < hour) return;

  try {
    if (localStorage.getItem(REVIEW_NUDGE_KEY) === store.today) return;
  } catch { /* 저장이 막혀 있으면 알림만 한 번 더 뜰 뿐이다 */ }

  let report;
  try {
    report = await api.get('/api/report/day', { day: store.today });
  } catch {
    return;
  }
  // 오늘 일한 흔적이 없으면 마무리할 것도 없다.
  if (report.active_sec < 1800) return;

  try { localStorage.setItem(REVIEW_NUDGE_KEY, store.today); } catch { /* 무시 */ }

  notify('하루를 마무리할 시간입니다',
    `오늘 몰입 ${dur(report.kinds.deep || 0)} · 계획 ${report.tasks.planned_done}/${report.tasks.planned} 완료`,
    { silent: store.settings.notify_sound === '0' });

  const el = h('div.toast', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
    h('span', '하루를 마무리할까요?',
      h('span.muted', { style: { display: 'block', fontSize: '11px' } },
        '계획과 실제를 보고 남은 것을 내일로 넘깁니다')),
    h('button.btn.sm.primary', {
      onclick: async () => {
        el.remove();
        const { openDayReview } = await import('./views/daily-plan.js');
        openDayReview(report, { onChange: () => currentInstance?.refresh?.() });
      },
    }, '열기'),
    h('button.btn.sm.ghost', { onclick: () => el.remove() }, '나중에'),
  );
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), 60_000);
}

/** 세션 타이머는 1초마다 갱신하되, DOM 은 상단 바만 다시 그린다. */
function startTickers() {
  setInterval(() => { if (store.session) renderFocusBar(); }, 1000);
  setInterval(() => { refreshTracker().then(checkDrift).catch(() => {}); }, 15_000);
  setInterval(() => { refreshSession().catch(() => {}); }, 20_000);
  setInterval(() => { checkSuggestion(); }, 180_000);
  setTimeout(() => { checkSuggestion(); }, 20_000);
  setInterval(() => { checkDayReview(); }, 600_000);
  setTimeout(() => { checkDayReview(); }, 40_000);
}

function bindKeys() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable;
    const modal = !document.getElementById('modal-root').hidden;

    if (!typing && !modal) {
      const view = VIEWS.find((v) => v.key === e.key);
      if (view) { location.hash = `#/${view.id}`; return; }
      if (e.key === 'ArrowLeft' && ['today', 'timeline'].includes(currentViewId())) { moveDay(-1); return; }
      if (e.key === 'ArrowRight' && ['today', 'timeline'].includes(currentViewId())) {
        if (!isToday()) moveDay(1);
        return;
      }
      if (e.key === 'i' && store.session) {
        api.post(`/api/sessions/${store.session.id}/interrupt`).then(() => toast('방해 1회 기록'));
        return;
      }
      if (e.key === 'f') {
        if (store.session) {
          endCurrentSession();
        } else {
          startFocus();
        }
        return;
      }
    }

    if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openPalette();
      return;
    }
    if (e.key === 'n' && !typing && !modal) {
      e.preventDefault();
      openQuickAdd('task');
    }
  });
}

async function boot() {
  try {
    await loadBase();
  } catch {
    mount(content, h('div.empty', '서버에 연결할 수 없습니다. 터미널에서 `npm start` 가 실행 중인지 확인하세요.'));
    return;
  }
  await refreshSession().catch(() => {});

  subscribe((reason) => {
    if (reason === 'tracker' || reason === 'tracker-tick') { renderTrackerChip(); return; }
    if (reason === 'session' || reason === 'session-start' || reason === 'session-end') {
      renderFocusBar();
      if (reason !== 'session') currentInstance?.refresh?.();
      return;
    }
    if (reason === 'rollover') {
      // 04시를 넘기면 화면이 새 업무일로 갈아 끼워진다 — 어제 숫자가 통째로 사라진 것처럼
      // 보이므로 한 줄로 이유를 말해 준다. 탭을 켜 둔 채 새벽까지 일하는 사람이 겪는다.
      toast('업무일이 바뀌었습니다 — 오늘 화면을 새로 불러왔습니다', 'ok', 6000);
    }
    if (reason === 'day' || reason === 'rollover') { renderDayNav(); currentInstance?.refresh?.(); return; }
    if (reason === 'base') { renderTrackerChip(); renderFocusBar(); }
    currentInstance?.refresh?.();
  });

  document.getElementById('palette-cue')?.addEventListener('click', () => openPalette());
  window.addEventListener('hashchange', renderView);
  renderTrackerChip();
  renderFocusBar();
  bindKeys();
  startTickers();
  watchDayRollover();
  await renderView();
}

boot();
