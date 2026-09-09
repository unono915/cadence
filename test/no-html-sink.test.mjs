import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 화면 코드에 HTML 주입 통로를 두지 않는다.
 *
 * 이 앱은 **다른 프로그램이 정한 창 제목**을 그대로 화면에 그린다. 창 제목은 우리가
 * 통제하지 못하는 문자열이다 — 어떤 프로그램이든 제목에 `<img onerror=…>` 를 넣을 수 있다.
 * 어딘가 한 군데라도 innerHTML 을 쓰면 그 순간부터 이 화면에서 남의 코드가 돌고,
 * 이 화면은 로컬 API 전체(백업 내보내기 포함)에 접근한다.
 *
 * 이런 것은 리뷰로 막기 어렵다. 편의 헬퍼 하나에 `html:` 같은 우회로가 슬쩍 생기고,
 * 몇 달 뒤 누군가 그걸 창 제목에 쓴다. 그래서 사람이 아니라 검사가 지키게 한다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, '..', 'web');

const FORBIDDEN = [
  'innerHTML',
  'outerHTML',
  'insertAdjacentHTML',
  'document.write',
  'eval(',
  'new Function(',
];

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return jsFiles(full);
    return e.isFile() && e.name.endsWith('.js') ? [full] : [];
  });
}

/** 주석은 뺀다 — "innerHTML 을 쓰지 않는다"고 적어 둔 설명까지 걸리면 검사가 못 쓰게 된다. */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('화면 코드에 HTML 주입 통로가 없다', () => {
  const files = jsFiles(WEB);
  assert.ok(files.length >= 10, `검사할 파일이 ${files.length}개뿐입니다 — 경로가 틀렸을 수 있습니다`);

  const hits = [];
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const needle of FORBIDDEN) {
      if (code.includes(needle)) hits.push(`${path.relative(WEB, file)}: ${needle}`);
    }
  }
  assert.deepEqual(hits, [], `HTML 주입 통로: ${hits.join(' | ')}`);
});

test('index.html 에 인라인 스크립트가 없다', () => {
  // CSP 의 script-src 'self' 가 성립하려면 인라인 스크립트가 없어야 한다.
  const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>/gi)];
  assert.equal(inline.length, 0, `인라인 <script> 가 ${inline.length}개 있습니다`);
});

test('키보드 포커스 링이 다른 규칙에 밀리지 않는다', () => {
  // `:where()` 는 우선순위를 0 으로 만든다. 그래서 위쪽의
  // `input[type="text"] { outline: none }` 이 이겨 버리고, 입력칸·선택상자·글상자에서는
  // 포커스 링이 아예 나오지 않았다 — 키보드로 폼을 채우는 사람은 자기가 어디 있는지 몰랐다.
  //
  // CSS 우선순위는 눈으로 읽어서는 놓치기 쉽고, 화면을 열어 봐도 마우스로 쓰면 드러나지 않는다.
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');

  const focusRules = css.split('}').filter((block) => block.includes(':focus-visible'));
  assert.ok(focusRules.length, 'focus-visible 규칙이 아예 없습니다');

  for (const rule of focusRules) {
    const selector = rule.split('{')[0];
    assert.doesNotMatch(selector, /:where\s*\(/,
      `focus-visible 규칙에 :where() 를 쓰면 우선순위가 0 이 됩니다: ${selector.trim().slice(0, 80)}`);
  }

  // 입력 요소들이 실제로 규칙에 들어 있는지도 확인한다.
  // 선택자를 쉼표·공백으로 쪼갠 뒤 정확히 일치하는 것을 찾는다 — 'a:focus-visible' 이
  // 'textarea:focus-visible' 안에 들어 있는 것을 맞았다고 세면 안 되므로.
  const selectors = focusRules
    .map((rule) => rule.split('{')[0])
    .join(',')
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  for (const tag of ['input', 'select', 'textarea', 'button', 'a']) {
    assert.ok(selectors.includes(`${tag}:focus-visible`),
      `${tag} 에 포커스 링이 없습니다 — 있는 것: ${selectors.join(' ')}`);
  }
});

test('hidden 속성이 어떤 규칙보다 우선한다', () => {
  // 브라우저 기본값 `[hidden] { display: none }` 은 **작성자 규칙에 진다.**
  // `.modal-root { display: grid }` 한 줄 때문에 닫힌 모달 배경이 화면 전체에 깔린 채로
  // 남았고, 앱의 모든 클릭을 삼켰다 — 화면은 멀쩡해 보였고 아무 오류도 나지 않았다.
  // 실제로 그렇게 며칠을 굴렸다.
  const css = fs.readFileSync(path.join(WEB, 'styles.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    '[hidden] { display: none !important } 규칙이 없습니다 — el.hidden 이 무력해집니다');

  // 코드가 실제로 hidden 을 켜고 끄는 자리가 있는지도 본다.
  // 규칙만 남고 쓰는 곳이 사라지면 이 검사는 아무것도 지키지 않는다.
  const users = jsFiles(WEB).filter((f) => /\.hidden\s*=|hidden:\s*true/.test(fs.readFileSync(f, 'utf8')));
  assert.ok(users.length >= 2,
    `hidden 을 토글하는 곳이 ${users.length}군데뿐입니다 — 검사 대상이 맞는지 확인하세요`);
});

test('눌린 상태를 색으로만 알리는 버튼이 없다', () => {
  // 이 화면은 "지금 고른 것" 을 `primary` 클래스(파란 배경)로 나타낸다. 그것만으로는
  // 화면 낭독기에서 버튼 셋이 나란히 있을 뿐이고, 어느 것이 골라져 있는지 알 수 없다.
  // 눈으로 보면 멀쩡해 보여서 놓치기 가장 쉬운 종류다 — 실제로 네 군데가 그랬다.
  //
  // 정확히 잡아내려면 코드를 해석해야 하므로, 파일 단위의 거친 규칙을 쓴다:
  // **`primary` 를 상태에 따라 켜고 끄는 파일이면 `aria-pressed` 도 있어야 한다.**
  // 거칠지만, 새로 만든 토글에서 이것을 빠뜨리면 그 파일에서 걸린다.
  const files = jsFiles(WEB);
  const offenders = [];
  for (const file of files) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const togglesPrimary = /\?\s*'primary'|'\s*primary'\s*:|\$\{[^}]*\?\s*' primary'/.test(code)
      || /className\s*=\s*`[^`]*primary/.test(code);
    if (togglesPrimary && !code.includes('aria-pressed')) {
      offenders.push(path.relative(WEB, file));
    }
  }
  assert.deepEqual(offenders, [],
    `눌린 상태를 색으로만 알립니다 (aria-pressed 를 함께 다세요): ${offenders.join(', ')}`);
});

/**
 * 마우스로만 누를 수 있는 자리를 남기지 않는다.
 *
 * `div`/`span`/`tr` 에 `onclick` 만 달면 마우스로는 되지만 키보드로는 **닿지도 누르지도
 * 못한다.** 화면 낭독기에서는 그냥 글 덩어리라 "누를 수 있다" 는 사실 자체가 전달되지 않는다.
 * 눈으로 보면 멀쩡해서, 만드는 사람은 끝까지 모른다.
 *
 * 감쌀 수 있으면 `<button>` 으로, 표의 행처럼 감쌀 수 없으면 `clickable()` 로 만든다.
 * 아래 목록은 **그러지 않아도 되는 이유가 있는 자리**다 — 새로 늘리려면 이유를 함께 적어야 한다.
 */
const CLICK_ONLY_OK = [
  // 팔레트는 ↑↓ 와 Enter 로 움직인다. 마우스 클릭은 덤이고, 키보드가 본길이다.
  'views/palette.js',
  // 타임라인 띠는 그림이다. 같은 기록을 아래 표에서 '⋯' 버튼으로 열 수 있다.
  'lib/charts.js',
  // 모달 바깥을 눌러 닫는 동작을 막는 것뿐 — 무언가를 실행하지 않는다.
  'lib/ui.js',
  // 태스크 제목을 누르면 상세가 열리는데, 바로 옆 '⋯' 버튼이 같은 일을 한다
  // (`aria-label` 도 붙어 있다). 제목까지 탭 정거장으로 만들면 목록을 훑는 사람에게는
  // 같은 자리를 두 번 지나게 하는 셈이라, 편해지는 게 아니라 번거로워진다.
  'views/task-item.js',
];

test('마우스로만 누를 수 있는 자리가 없다', () => {
  const offenders = [];
  for (const file of jsFiles(WEB)) {
    const rel = path.relative(WEB, file).split(path.sep).join('/');
    if (CLICK_ONLY_OK.includes(rel)) continue;

    const code = stripComments(fs.readFileSync(file, 'utf8'));
    for (const m of code.matchAll(/onclick\s*:/g)) {
      const before = code.slice(Math.max(0, m.index - 600), m.index);
      // 이 onclick 이 어떤 태그에 붙는지 뒤로 훑어 찾는다.
      const call = [...before.matchAll(/\b(h|svg)\(\s*'([^']*)'/g)].pop();
      const tag = call ? (call[2].split(/[.#]/)[0] || 'div') : '?';
      if (['button', 'a'].includes(tag)) continue;
      // 헬퍼를 거치면 role·tabindex·키 처리가 함께 붙는다.
      if (/\b(clickable|rowButton)\(/.test(before)) continue;
      offenders.push(`${rel}:${code.slice(0, m.index).split('\n').length} <${tag}>`);
    }
  }
  assert.deepEqual(offenders, [],
    `키보드로 누를 수 없습니다 (button 으로 만들거나 clickable() 을 쓰세요):\n  ${offenders.join('\n  ')}`);
});

test('토글 그룹은 눌린 상태를 화면 낭독기에도 알린다', () => {
  // 어느 것이 눌려 있는지를 색으로만 표시하면, 화면 낭독기에서는 그냥 버튼이 나란히 있을 뿐이다.
  // 눈으로 보면 멀쩡해 보여서 놓치기 쉬운 종류다.
  const ui = fs.readFileSync(path.join(WEB, 'lib', 'ui.js'), 'utf8');
  assert.match(ui, /aria-pressed/, 'pillGroup 이 aria-pressed 를 붙이지 않습니다');

  // 부르는 쪽은 모두 이름을 준다 — 이름 없는 그룹은 "그룹" 이라고만 읽힌다.
  const views = fs.readdirSync(path.join(WEB, 'views'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => [f, fs.readFileSync(path.join(WEB, 'views', f), 'utf8')]);

  const unnamed = [];
  for (const [file, code] of views) {
    // pillGroup( ... ) 한 덩어리씩 잘라 label 이 있는지 본다.
    let from = 0;
    for (;;) {
      const at = code.indexOf('pillGroup(', from);
      if (at < 0) break;
      const end = code.indexOf('\n      ),', at) >= 0
        ? Math.min(...[code.indexOf('\n      ),', at), code.indexOf('\n        ),', at)].filter((x) => x > 0))
        : code.length;
      const chunk = code.slice(at, end);
      if (!chunk.includes('label:')) unnamed.push(`${file}: ${chunk.split('\n')[1]?.trim().slice(0, 40)}`);
      from = at + 10;
    }
  }
  assert.deepEqual(unnamed, [], `이름 없는 토글 그룹: ${unnamed.join(' | ')}`);
});
