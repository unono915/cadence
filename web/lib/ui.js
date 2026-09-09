import { h, mount, clear } from './dom.js';

/** 짧은 알림. kind: 'ok' | 'err' | '' */
export function toast(message, kind = '', ms = 3200) {
  const root = document.getElementById('toasts');
  if (!root) return;
  const el = h(`div.toast${kind ? `.${kind}` : ''}`, message);
  root.append(el);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/**
 * 눌러서 뭔가를 여는 줄을 키보드로도 쓸 수 있게 만든다.
 *
 * `onclick` 만 단 `div`/`tr` 은 마우스로는 되지만 키보드로는 **닿지도, 누르지도 못한다.**
 * 화면 낭독기에서는 그냥 글 덩어리라 "누를 수 있다" 는 사실 자체가 전달되지 않는다.
 * 표의 행처럼 `<button>` 으로 감쌀 수 없는 자리를 위한 것이다 —
 * 감쌀 수 있는 곳은 그냥 버튼으로 만드는 편이 낫다.
 *
 * @param {(el: HTMLElement) => void} run 누를 때 할 일
 */
export function clickable(props, run, label) {
  return {
    ...props,
    role: 'button',
    tabIndex: 0,
    'aria-label': label ?? props['aria-label'] ?? undefined,
    onclick: run,
    onkeydown: (e) => {
      // 스페이스는 기본값이 스크롤이라 막아야 한다. 엔터는 그대로 두면 폼을 보낼 수 있다.
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      run(e);
    },
  };
}

let closeModal = null;

/**
 * 실수로 닫아서 쓰던 글을 잃는 일을 막는다.
 *
 * 모달은 배경을 누르거나 Esc 를 치면 닫힌다. 편한 대신 대가가 있다 —
 * **길게 쓴 메모를 빗나간 클릭 한 번으로 통째로 버린다.** 태스크 메모 칸은 8000자까지
 * 받고, 하루 마무리 회고도 이 모달 안에서 쓴다. 그걸 아무 말 없이 없애는 것은
 * 이 도구가 저지를 수 있는 가장 나쁜 일에 가깝다 — 되돌릴 방법이 없기 때문이다.
 *
 * 확인 대화상자를 겹쳐 띄우는 방법은 쓸 수 없다. `openModal()` 은 새 모달을 열 때
 * 열려 있던 것을 먼저 닫는데, 그러면 지키려던 내용이 물어보기도 전에 사라진다.
 * 그래서 한 번 더 누르게 한다 — 첫 번째는 알리고, 그 직후의 두 번째는 닫는다.
 * 취소·닫기 단추처럼 **작정하고 누른 것**은 여기를 거치지 않고 바로 닫힌다.
 */
export class DismissGuard {
  /**
   * @param {() => boolean} isDirty 쓰던 내용이 있는지
   * @param {(ms: number) => void} warn 알릴 방법. 받아 주는 시간을 ms 로 받는다
   * @param {number} windowMs 두 번째 누름을 받아 주는 시간
   */
  constructor(isDirty, warn, windowMs = 4000) {
    this.isDirty = isDirty;
    this.warn = warn;
    this.windowMs = windowMs;
    this.armedUntil = 0;
  }

  /**
   * 닫으려는 시도. 닫아도 되면 true.
   * @param {number} now 검사에서 시각을 넣기 위한 것 — 평소에는 넘기지 않는다.
   */
  request(now = Date.now()) {
    if (!this.isDirty()) return true;
    if (now < this.armedUntil) return true;
    this.armedUntil = now + this.windowMs;
    this.warn(this.windowMs);
    return false;
  }

  /**
   * 다시 처음부터.
   *
   * 알린 뒤에 사용자가 계속 타이핑했다면 그건 "아직 쓰는 중" 이라는 뜻이다.
   * 그 상태에서 손이 미끄러져 Esc 가 눌리면, 열어 둔 창을 그대로 닫아 버리게 된다.
   */
  disarm() { this.armedUntil = 0; }
}

/** 입력칸의 현재 값 — 체크박스는 value 가 아니라 눌림 여부가 내용이다. */
function fieldValue(el) {
  return el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : el.value;
}

/**
 * 모달을 띄운다. render(close) 는 { title, body, footer } 를 돌려준다.
 * 닫기·취소 단추는 바로 닫히고, Esc 와 배경 클릭은 쓰던 내용이 있으면 한 번 더 물어본다.
 */
export function openModal(render) {
  const root = document.getElementById('modal-root');
  if (!root) return () => {};
  if (closeModal) closeModal();

  // 모달을 연 요소로 포커스를 돌려준다 — 키보드로 쓸 때 자리를 잃지 않도록.
  const opener = document.activeElement;

  const close = () => {
    root.hidden = true;
    clear(root);
    document.removeEventListener('keydown', onKey);
    closeModal = null;
    if (opener && document.contains(opener)) opener.focus?.();
  };

  // mount 뒤에 채워진다. Esc 는 그 뒤에야 올 수 있으므로 여기서 비어 있어도 괜찮다.
  let requestClose = close;

  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); requestClose(); return; }
    // 포커스가 모달 밖으로 새지 않게 가둔다.
    if (e.key !== 'Tab') return;
    const focusable = [...root.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.disabled && el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const { title, body, footer } = render(close);
  const modal = h('div.modal', {
    onclick: (e) => e.stopPropagation(),
    role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'modal-title',
  },
    h('header',
      h('span', { id: 'modal-title' }, title),
      h('button.btn.ghost.sm', { onclick: close, title: '닫기 (Esc)', 'aria-label': '닫기' }, '✕'),
    ),
    h('div.body', body),
    footer ? h('footer', footer) : null,
  );

  root.hidden = false;
  mount(root, modal);

  // 열린 순간의 값을 적어 둔다. 여기서 달라진 것이 있으면 "쓰던 내용" 이다.
  // render() 안에서 채워 넣은 기존 값(수정 모달의 제목·메모 등)은 이미 들어와 있으므로,
  // 그것만으로는 더럽다고 보지 않는다 — 아무것도 건드리지 않고 닫는 길은 그대로 열려 있다.
  const fields = [...modal.querySelectorAll('input, textarea, select')]
    .map((el) => [el, fieldValue(el)]);
  const guard = new DismissGuard(
    () => fields.some(([el, initial]) => fieldValue(el) !== initial),
    (ms) => toast('쓰던 내용이 있습니다 — 한 번 더 누르면 닫고 버립니다', '', ms),
  );
  modal.addEventListener('input', () => guard.disarm());
  requestClose = () => { if (guard.request()) close(); };

  root.onclick = requestClose;
  document.addEventListener('keydown', onKey);
  closeModal = close;

  // 열자마자 포커스를 안으로 옮긴다.
  //
  // 먼저 칠 자리(입력칸)나 주 동작(primary)을 고르고, 둘 다 없으면 아무 버튼이라도 잡는다.
  // 예전에는 못 찾으면 그냥 두었는데, 그러면 포커스가 모달 밖에 남아 있어서 첫 Tab 이
  // **뒤에 있는 화면으로** 넘어갔다 — 가둬 놓은 것이 무색해진다.
  const first = modal.querySelector('input, textarea, select, button.primary')
    || modal.querySelector('button');
  if (first) setTimeout(() => first.focus(), 30);
  return close;
}

/** 확인 대화상자. Promise<boolean> */
export function confirmDialog(message, { title = '확인', danger = false, okLabel = '확인' } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let observer = null;
    // 버튼으로 끝나든 배경 클릭으로 닫히든, 감시자는 반드시 끊어 준다.
    const settle = (value) => {
      if (settled) return;
      settled = true;
      observer?.disconnect();
      resolve(value);
    };
    const done = (value, close) => { close(); settle(value); };

    openModal((close) => {
      // 배경 클릭/Esc 로 닫힌 경우도 false 로 처리
      queueMicrotask(() => {
        const root = document.getElementById('modal-root');
        observer = new MutationObserver(() => {
          if (root.hidden) settle(false);
        });
        observer.observe(root, { attributes: true, attributeFilter: ['hidden'] });
      });
      return {
        title,
        body: h('div', { style: { fontSize: '14px', lineHeight: '1.6' } }, message),
        footer: [
          h('button.btn', { onclick: () => done(false, close) }, '취소'),
          h(`button.btn.primary${danger ? '.danger' : ''}`, { onclick: () => done(true, close) }, okLabel),
        ],
      };
    });
  });
}

/**
 * 세그먼트 토글 버튼 그룹.
 *
 * 어느 것이 눌려 있는지를 색으로만 표시하면 화면 낭독기에서는 그냥 버튼 넷이 나란히 있을 뿐이다.
 * aria-pressed 로 상태를 말해 준다.
 */
export function pillGroup(options, value, onChange, { label = '' } = {}) {
  return h('div.pill-group', { role: 'group', 'aria-label': label || undefined },
    options.map((opt) => h('button', {
      class: opt.value === value ? 'on' : '',
      'aria-pressed': opt.value === value ? 'true' : 'false',
      onclick: () => onChange(opt.value),
      title: opt.title || '',
    }, opt.label)),
  );
}
