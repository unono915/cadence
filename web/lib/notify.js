/**
 * 세션 종료 알림.
 *
 * 집중 타이머는 다른 창에서 일하는 동안 돌아간다 — 화면을 보고 있지 않아도 끝난 것을
 * 알 수 있어야 쓸모가 있다. 그래서 세 가지를 함께 쓴다.
 *   1) 브라우저 알림 (권한이 있을 때)
 *   2) 탭 제목 카운트다운 (권한이 없어도 보인다)
 *   3) WebAudio 로 만든 짧은 신호음 (오디오 파일 없이)
 */

let audioCtx = null;

/** 짧은 두 음. 외부 파일 없이 그때그때 합성한다. */
export function chime({ volume = 0.16 } = {}) {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.18;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t);
      osc.stop(t + 0.34);
    });
  } catch {
    // 오디오는 부가 기능이다 — 막혀 있어도 조용히 넘어간다.
  }
}

export function notificationState() {
  if (!('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

export async function requestNotifications() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export function notify(title, body, { silent = false } = {}) {
  if (!silent) chime();
  if (!('Notification' in window) || Notification.permission !== 'granted') return null;
  try {
    const n = new Notification(title, {
      body,
      tag: 'cadence-session',
      icon: '/icon.svg',
      silent: true, // 소리는 우리가 직접 낸다
    });
    n.onclick = () => { window.focus(); n.close(); };
    setTimeout(() => n.close(), 12_000);
    return n;
  } catch {
    return null;
  }
}

/**
 * 탭 제목에 남은 시간을 표시한다.
 * 다른 창에서 일하다가 탭 목록만 봐도 알 수 있게 하는 것이 목적.
 */
const BASE_TITLE = 'Cadence';
let titleView = null;

export function setTitleTimer(text, viewName) {
  if (viewName) titleView = viewName;
  document.title = text
    ? `${text} · ${BASE_TITLE}`
    : `${BASE_TITLE}${titleView ? ` — ${titleView}` : ''}`;
}
