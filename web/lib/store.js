import { api } from './api.js';
import { todayKey, shiftDay } from './format.js';

/** 앱 전역 상태. 뷰는 subscribe 로 변화를 구독한다. */
const listeners = new Set();

export const store = {
  today: todayKey(),
  day: todayKey(),
  settings: {},
  categories: [],
  projects: [],
  tracker: { supported: true, running: false },
  session: null,
  dayStartHour: 4,
};

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notify(reason = '') {
  for (const fn of [...listeners]) {
    try { fn(reason); } catch (err) { console.error(err); }
  }
}

export function setDay(day) {
  if (store.day === day) return;
  store.day = day;
  notify('day');
}

export function moveDay(delta) {
  setDay(shiftDay(store.day, delta));
}

export function isToday() {
  return store.day === store.today;
}

/** 서버에서 기준 정보를 불러온다. 앱 기동 시 한 번, 설정 변경 시 다시 호출. */
export async function loadBase() {
  const [settings, categories, projects, health] = await Promise.all([
    api.get('/api/settings'),
    api.get('/api/categories'),
    api.get('/api/projects'),
    api.get('/api/health'),
  ]);
  store.settings = settings;
  store.categories = categories;
  store.projects = projects;
  store.dayStartHour = health.day_start_hour;
  store.tracker = health.tracker;
  const prevToday = store.today;
  store.today = health.today;
  if (store.day === prevToday || !store.day) store.day = health.today;
  applyTheme(settings.theme);
  notify('base');
}

export async function refreshProjects() {
  store.projects = await api.get('/api/projects');
  notify('projects');
}

export async function refreshTracker() {
  const prevRunning = store.tracker?.running;
  store.tracker = await api.get('/api/tracker');
  if (prevRunning !== store.tracker.running) notify('tracker');
  else notify('tracker-tick');
}

export async function refreshSession() {
  const prev = store.session?.id ?? null;
  store.session = await api.get('/api/sessions/running');
  if ((store.session?.id ?? null) !== prev) notify('session');
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
  else delete root.dataset.theme;
}

/** 자정(업무일 경계)을 넘겼는지 주기적으로 확인해 '오늘'을 갱신한다. */
export function watchDayRollover() {
  setInterval(() => {
    const next = todayKey(store.dayStartHour);
    if (next !== store.today) {
      const wasOnToday = store.day === store.today;
      store.today = next;
      if (wasOnToday) store.day = next;
      notify('rollover');
    }
  }, 60_000);
}

/**
 * 화면이 기억해 둔 선택(보기 방식, 기간 등)을 **믿지 않고** 읽는다.
 *
 * 저장된 값이 허용된 것 중에 없으면 기본값으로 돌아간다. 사소해 보이지만
 * 리포트 화면에서 실제로 사람을 가둔 적이 있다 — 기간 값이 숫자가 아니면 서버가 400 을
 * 내고, 화면은 통째로 "불러오지 못했습니다" 가 된다. 그 화면에는 다시 시도 단추밖에
 * 없는데, 눌러도 같은 값을 또 보내니 **영원히 같은 자리에 머문다.** 브라우저 저장소를
 * 직접 지우는 것 말고는 빠져나올 길이 없다.
 *
 * 손댄 사람이 없어도 그렇게 된다 — 다음 판에서 고를 수 있는 값이 바뀌면, 옛 값을
 * 들고 있던 사람만 조용히 갇힌다. 오래 쓴 사람일수록 그렇다.
 *
 * 저장소 접근 자체가 예외를 던지는 브라우저 설정도 있으므로 통째로 감싼다.
 *
 * @param {string} key 저장소 키
 * @param {Array<string|number>} allowed 허용되는 값들. 첫 번째가 기본값이다.
 */
export function remembered(key, allowed) {
  const fallback = allowed[0];
  let raw;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return fallback; // 저장소를 못 쓰는 환경 — 기본값으로 굴러가면 된다.
  }
  if (raw === null) return fallback;
  // 숫자로 저장한 값은 문자열로 돌아온다. 원래 형태를 유지해서 돌려준다.
  const found = allowed.find((v) => String(v) === raw);
  return found === undefined ? fallback : found;
}

/** 선택을 기억해 둔다. 저장소가 막혀 있어도 화면이 멈추지는 않게. */
export function remember(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch { /* 저장에 실패해도 이번 화면은 그대로 쓴다 */ }
}
