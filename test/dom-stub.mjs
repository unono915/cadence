/**
 * 검사용 최소 DOM.
 *
 * `web/lib/charts.js` 는 숫자를 SVG 좌표로 바꾸는 코드다. 여기서 틀리면 예외가 나지 않는다 —
 * `width="NaN%"` 나 `d="M NaN 0"` 은 브라우저가 **조용히 무시**하고 빈 자리를 남긴다.
 * 화면은 멀쩡히 뜨고 오류도 없고, 다만 막대가 안 보인다. 눈으로 보기 전에는 아무도 모른다.
 *
 * 그런데 그 코드는 `document` 없이는 한 줄도 돌지 않는다. 브라우저를 띄우는 검사는
 * 무거워서 매번 돌리지 않게 되고, 매번 돌지 않는 검사는 없는 것과 같다.
 * 그래서 `dom.js` 가 실제로 쓰는 것만 흉내 낸다 — 브라우저가 아니라 **받침대**다.
 * 여기 없는 기능을 쓰는 코드는 이 받침대로 검사할 수 없고, 그건 그대로 두는 편이 낫다.
 * 흉내가 커질수록 "검사에서는 되는데 화면에서는 안 되는" 자리가 늘어난다.
 */

class StubNode {}

class StubText extends StubNode {
  constructor(text) {
    super();
    this.text = String(text);
  }

  get textContent() { return this.text; }
}

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr']);

class StubElement extends StubNode {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.attrs = new Map();
    this.children = [];
    this.events = new Map();
    this.className = '';
    this.id = '';
    this.style = {};
    this.dataset = {};
    this.hidden = false;
  }

  setAttribute(key, value) { this.attrs.set(key, String(value)); }

  getAttribute(key) { return this.attrs.has(key) ? this.attrs.get(key) : null; }

  addEventListener(type, fn) {
    if (!this.events.has(type)) this.events.set(type, []);
    this.events.get(type).push(fn);
  }

  append(...nodes) {
    for (const n of nodes) this.children.push(n);
  }

  removeChild(node) {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    return node;
  }

  get firstChild() { return this.children[0] ?? null; }

  set textContent(value) { this.children = [new StubText(value)]; }

  get textContent() { return this.children.map((c) => c.textContent ?? '').join(''); }

  /** 검사에서 문자열로 훑어보기 위한 것. 진짜 직렬화가 아니다. */
  get outerHTML() {
    const parts = [];
    if (this.id) parts.push(`id="${this.id}"`);
    if (this.className) parts.push(`class="${this.className}"`);
    for (const [k, v] of this.attrs) parts.push(`${k}="${v}"`);
    const style = typeof this.style === 'string'
      ? this.style
      : Object.entries(this.style).map(([k, v]) => `${k}:${v}`).join(';');
    if (style) parts.push(`style="${style}"`);
    const open = `<${this.tagName}${parts.length ? ` ${parts.join(' ')}` : ''}>`;
    if (VOID_TAGS.has(this.tagName)) return open;
    const inner = this.children
      .map((c) => (c instanceof StubText ? c.text : c.outerHTML))
      .join('');
    return `${open}${inner}</${this.tagName}>`;
  }
}

/**
 * 전역에 받침대를 깐다. `dom.js` 를 **불러오기 전에** 불러야 한다 —
 * 모듈 최상단에서 `document` 를 잡아 두는 코드가 있으면 늦는다.
 */
export function installDom() {
  globalThis.Node = StubNode;
  globalThis.document = {
    createElement: (tag) => new StubElement(tag),
    createElementNS: (_ns, tag) => new StubElement(tag),
    createTextNode: (text) => new StubText(text),
    getElementById: () => null,
    documentElement: new StubElement('html'),
  };
  return globalThis.document;
}

export { StubElement, StubText, StubNode };
