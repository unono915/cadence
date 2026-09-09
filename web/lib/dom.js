/**
 * 아주 작은 하이퍼스크립트 헬퍼. 빌드 도구 없이 DOM 을 조립하기 위한 최소 도구.
 *
 * 자식은 반드시 createTextNode 로 넣는다 — 이 앱은 **다른 프로그램이 정한 창 제목**을
 * 그대로 화면에 그린다. 어딘가에서 innerHTML 을 쓰는 순간, 창 제목에 태그를 넣을 수 있는
 * 아무 프로그램이나 이 화면에서 코드를 실행할 수 있게 된다(그리고 이 화면은 API 전체에
 * 접근한다). 그래서 innerHTML 은 한 군데도 두지 않는다 — test/no-html-sink.test.mjs 가 지킨다.
 */

const SELECTOR_RE = /([.#][^.#]+)/g;

/**
 * h('div.card#main', { onclick, style, dataset, ... }, ...children)
 * - 두 번째 인자가 객체가 아니면 자식으로 취급한다.
 * - children 은 문자열 / 노드 / 배열 / null 을 받는다.
 */
export function h(spec, props, ...children) {
  let tag = 'div';
  const classes = [];
  let id = null;

  const base = spec.split(/[.#]/)[0];
  if (base) tag = base;
  const rest = spec.slice(base.length);
  for (const [, token] of rest.matchAll(SELECTOR_RE)) {
    if (token[0] === '.') classes.push(token.slice(1));
    else id = token.slice(1);
  }

  const el = document.createElement(tag);
  if (classes.length) el.className = classes.join(' ');
  if (id) el.id = id;

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }

  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class' || key === 'className') {
        el.className = [el.className, value].filter(Boolean).join(' ');
      } else if (key === 'style' && typeof value === 'object') {
        Object.assign(el.style, value);
      } else if (key === 'dataset') {
        Object.assign(el.dataset, value);
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2), value);
      } else if (key in el && key !== 'list' && typeof value !== 'object') {
        el[key] = value;
      } else {
        el.setAttribute(key, value === true ? '' : value);
      }
    }
  }

  append(el, children);
  return el;
}

export function append(el, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

/** SVG 전용 h — 네임스페이스가 달라 별도 함수가 필요하다. */
export function svg(spec, props, ...children) {
  let tag = 'svg';
  const classes = [];
  const base = spec.split(/[.#]/)[0];
  if (base) tag = base;
  for (const [, token] of spec.slice(base.length).matchAll(SELECTOR_RE)) {
    if (token[0] === '.') classes.push(token.slice(1));
  }
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (classes.length) el.setAttribute('class', classes.join(' '));

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value);
    }
  }
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}
