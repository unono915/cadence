import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 글자와 배경의 대비.
 *
 * 이 화면은 흐린 글씨(`--muted`)로 부가 정보를 많이 쓴다 — 11~12px 짜리 작은 글씨다.
 * 대비가 모자라면 눈이 좋은 사람에게는 "차분한 회색" 이지만 다른 사람에게는 안 보인다.
 * 실제로 두 테마 모두 `--muted` 가 기준(4.5:1)에 못 미쳤고, 화면을 봐서는 알 수 없었다.
 *
 * 색은 감으로 고르게 되므로, 고칠 때마다 사람이 계산기를 두드리게 하면 결국 안 한다.
 * 검사에 맡긴다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.resolve(here, '..', 'web', 'styles.css'), 'utf8');

/** WCAG 2.1 기준: 보통 크기 글자는 4.5:1 이상. */
const AA = 4.5;

function channels(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `색이 6자리 16진수가 아닙니다: ${hex}`);
  return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
}

function luminance(hex) {
  const [r, g, b] = channels(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(fg, bg) {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * 테마 블록에서 색 변수를 뽑는다.
 * 어두운 테마는 `:root`, 밝은 테마는 `[data-theme="light"]` 에 있다.
 */
function themeVars(selector) {
  const start = CSS.indexOf(selector);
  assert.ok(start >= 0, `${selector} 블록을 찾지 못했습니다`);
  const block = CSS.slice(CSS.indexOf('{', start) + 1, CSS.indexOf('}', start));
  const vars = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    vars[name] = value;
  }
  return vars;
}

/** 글자로 쓰이는 색과, 그 색이 얹히는 바탕들. */
const TEXT_ON = ['bg', 'panel', 'panel-2'];
const TEXT_COLORS = ['text', 'text-dim', 'muted', 'accent', 'good', 'warn', 'bad'];

for (const [label, selector] of [['어두운 테마', ':root {'], ['밝은 테마', '[data-theme="light"]']]) {
  test(`${label}의 글자 대비가 기준을 넘는다`, () => {
    const vars = themeVars(selector);
    for (const name of [...TEXT_COLORS, ...TEXT_ON]) {
      assert.ok(vars[name], `${label}에 --${name} 이 없습니다`);
    }

    const failures = [];
    for (const fg of TEXT_COLORS) {
      for (const bg of TEXT_ON) {
        const ratio = contrast(vars[fg], vars[bg]);
        if (ratio < AA) {
          failures.push(`--${fg}(${vars[fg]}) on --${bg}(${vars[bg]}) = ${ratio.toFixed(2)}`);
        }
      }
    }
    assert.deepEqual(failures, [],
      `대비가 ${AA}:1 에 못 미칩니다:\n  ${failures.join('\n  ')}`);
  });
}

test('두 테마가 같은 색 변수를 갖는다', () => {
  // 한쪽에만 있는 변수는 다른 테마에서 상속돼 엉뚱한 색이 된다 —
  // 밝은 테마에서 어두운 테마의 색이 그대로 나오는 식이다.
  const dark = Object.keys(themeVars(':root {'));
  const light = Object.keys(themeVars('[data-theme="light"]'));
  const missing = dark.filter((k) => !light.includes(k));
  assert.deepEqual(missing, [], `밝은 테마에 빠진 색: ${missing.join(', ')}`);
});

test('시스템 설정을 따르는 블록도 같은 색을 쓴다', () => {
  // 테마가 'auto' 일 때는 @media (prefers-color-scheme: light) 블록이 쓰인다.
  // 여기가 [data-theme="light"] 와 어긋나면, 같은 밝은 화면인데 색이 달라진다.
  const explicit = themeVars('[data-theme="light"]');
  const media = themeVars('@media (prefers-color-scheme: light)');
  const diffs = Object.entries(explicit)
    .filter(([k, v]) => media[k] && media[k] !== v)
    .map(([k, v]) => `--${k}: ${v} ≠ ${media[k]}`);
  assert.deepEqual(diffs, [], `밝은 테마 두 곳의 색이 다릅니다: ${diffs.join(', ')}`);
});
