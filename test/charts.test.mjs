import test from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './dom-stub.mjs';

installDom(); // charts.js → dom.js 가 document 를 쓰므로 불러오기 전에 깐다.

const charts = await import('../web/lib/charts.js');

/**
 * 그림이 조용히 비지 않는지 본다.
 *
 * 차트 코드가 하는 일은 숫자를 좌표로 바꾸는 것뿐이다. 여기서 틀려도 **예외가 나지 않는다** —
 * `width="NaN%"`, `opacity="NaN"`, `stroke-dasharray="undefined"` 는 브라우저가 조용히
 * 무시하고 빈 자리를 남긴다. 화면은 멀쩡히 뜨고 콘솔도 깨끗하고, 다만 막대가 안 보인다.
 * 눈으로 열어 보기 전까지 아무도 모르고, 열어 봐도 "오늘은 기록이 없나 보다" 로 읽힌다 —
 * 틀린 값을 보여 주는 것보다 나쁠 수도 있다.
 *
 * **표본은 서버가 실제로 보내는 모양 그대로 쓴다.** 처음 이 검사를 쓸 때 필드 이름을
 * 대충 지어 넣었더니 `rhythmChart` 가 `opacity="NaN"` 을 냈다 — 코드가 아니라 표본이
 * 틀린 것이었다. 모양이 다른 표본으로 도는 검사는 아무것도 지키지 않으면서 사람을
 * 엉뚱한 데로 보낸다. 그래서 값만 못되게 하고 **이름과 구조는 실제 응답을 따른다.**
 */

const BROKEN = /NaN|undefined|Infinity/;

function render(label, fn) {
  let el;
  try {
    el = fn();
  } catch (err) {
    assert.fail(`${label}: 예외가 났습니다 — ${err.message}`);
  }
  const html = el?.outerHTML ?? String(el);
  const hit = html.match(BROKEN);
  assert.equal(hit, null,
    `${label}: 그림에 ${hit?.[0]} 가 들어갔습니다 — 브라우저는 이걸 조용히 무시합니다\n  ${html.slice(0, 240)}`);
  return html;
}

/** `by_category` · `top_apps` 가 화면에서 쓰이는 모양. 값만 못되게 바꾼다. */
const ITEM_CASES = [
  ['빈 목록', []],
  ['값이 0', [{ name: '개발', seconds: 0, color: '#4f9d69' }]],
  ['값이 null', [{ name: '개발', seconds: null, color: null }]],
  ['값이 NaN', [{ name: '개발', seconds: NaN, color: '#4f9d69' }]],
  ['값이 음수', [{ name: '개발', seconds: -100, color: '#4f9d69' }]],
  ['아주 큰 값', [{ name: '개발', seconds: 1e18, color: '#4f9d69' }]],
  ['하나만 망가짐', [
    { name: '개발', seconds: 3600, color: '#4f9d69' },
    { name: '회의', seconds: null, color: '#e0a458' },
    { name: '미분류', seconds: NaN, color: '#6b7280' },
  ]],
];

test('막대 목록이 어떤 값에도 깨지지 않는다', () => {
  for (const [label, items] of ITEM_CASES) {
    render(`barList/${label}`, () => charts.barList(items, { total: 0 }));
    render(`barList/${label}/합계있음`, () => charts.barList(items, { total: 3600 }));
    render(`barList/${label}/누를수있음`, () => charts.barList(items, { total: 60, onClick: () => {} }));
  }
});

test('값 하나가 망가져도 나머지 막대는 그대로 그려진다', () => {
  // `Math.max` 는 NaN 하나에 통째로 물든다. 그래서 예전에는 목록에 이상한 값이 하나만
  // 섞여도 **모든 줄의 막대**가 사라졌다 — 멀쩡한 줄까지.
  const html = charts.barList([
    { name: '개발', seconds: 3600, color: '#4f9d69' },
    { name: '망가진 것', seconds: NaN, color: '#d9534f' },
  ], { total: 3600 }).outerHTML;
  assert.match(html, /width:100%/, '멀쩡한 줄의 막대까지 사라졌습니다');
});

test('도넛과 범례가 어떤 값에도 깨지지 않는다', () => {
  for (const [label, items] of ITEM_CASES) {
    render(`donut/${label}`, () => charts.donut(items));
    render(`legend/${label}`, () => charts.legend(items, 0));
    render(`legend/${label}/합계있음`, () => charts.legend(items, 3600));
  }
});

test('점수 고리가 어떤 값에도 깨지지 않는다', () => {
  for (const score of [null, undefined, NaN, -5, 0, 50, 100, 1e9]) {
    render(`scoreRing/${score}`, () => charts.scoreRing(score));
  }
});

test('타임라인 띠가 어떤 값에도 깨지지 않는다', () => {
  const now = Date.parse('2026-06-10T10:00:00');
  /** `/api/activity` 가 돌려주는 모양. 미분류 기록은 색·이름이 실제로 null 이다. */
  const seg = (over = {}) => ({
    id: 1, app: 'Code', title: 'main.mjs', exe: 'code.exe',
    started_at: now, ended_at: now + 600_000, seconds: 600,
    idle: 0, category_id: null, task_id: null, day: '2026-06-10',
    reviewed: 0, pinned: 0,
    category_name: null, category_color: null, category_kind: null, task_title: null,
    ...over,
  });
  const cases = [
    ['빈 목록', []],
    ['미분류 (색·이름이 null)', [seg()]],
    ['자리비움', [seg({ idle: 1, app: '(자리비움)', title: '' })]],
    ['분류됨', [seg({ category_name: '개발', category_color: '#4f9d69', category_kind: 'deep' })]],
    ['시각이 NaN', [seg({ started_at: NaN, ended_at: null, seconds: -1 })]],
    ['끝이 시작보다 앞', [seg({ ended_at: now - 60_000 })]],
    ['같은 시각', [seg({ ended_at: now, seconds: 0 })]],
  ];
  for (const [label, segments] of cases) {
    render(`timelineStrip/${label}`, () => charts.timelineStrip(segments));
    // 몰입 블록은 `deepBlocks()` 가 만든 모양 그대로.
    render(`timelineStrip/${label}/블록`, () => charts.timelineStrip(segments, {
      blocks: [{ start: now, end: now + 60_000, deep_sec: 60, breaks_sec: 0, span_sec: 60, top_app: 'Code' }],
    }));
  }
});

test('추세 그래프가 어떤 값에도 깨지지 않는다', () => {
  const series = [{ key: 'deep_sec', color: 'var(--good)', label: '몰입' }];
  /** `/api/report/trend` 가 돌려주는 모양. */
  const point = (over = {}) => ({
    day: '2026-06-10', score: 50, unreliable: false, unclassified_ratio: 0,
    active_sec: 3600, deep_sec: 1800, distraction_sec: 0, meeting_sec: 0,
    comms_sec: 0, shallow_sec: 0, blocks: 1, switches_per_hour: 5,
    sessions: 1, tasks_done: 0,
    ...over,
  });
  const cases = [
    ['빈 목록', []],
    ['한 점', [point()]],
    ['모두 0', [point({ deep_sec: 0 }), point({ day: '2026-06-11', deep_sec: 0 })]],
    ['값이 null', [point({ deep_sec: null }), point({ day: '2026-06-11', deep_sec: null })]],
    ['값이 NaN', [point({ deep_sec: NaN }), point({ day: '2026-06-11' })]],
    ['날짜가 비었음', [point({ day: null }), point({ day: '2026-06-11' })]],
  ];
  for (const [label, data] of cases) {
    render(`trendChart/${label}`, () => charts.trendChart(data, series));
  }
});

test('리듬·요일·시간대 그림이 어떤 값에도 깨지지 않는다', () => {
  /** `/api/report/rhythm` 의 hours/weekdays — 기록이 없으면 `deep_ratio` 가 실제로 null 이다. */
  const hour = (i, over = {}) => ({
    hour: i, deep_sec: 0, active_sec: 0, deep_ratio: null,
    deep_per_day: 0, active_per_day: 0, days: 0, ...over,
  });
  const weekday = (i, over = {}) => ({
    dow: i, label: '월', deep_sec: 0, active_sec: 0, deep_ratio: null,
    deep_per_day: 0, active_per_day: 0, days: 0, ...over,
  });
  const all24 = (over) => Array.from({ length: 24 }, (_, i) => hour(i, typeof over === 'function' ? over(i) : over));

  for (const [label, hours] of [
    ['빈 목록', []],
    ['기록 없음 (전부 0)', all24()],
    ['정상', all24((i) => ({ active_sec: i * 60, deep_ratio: i / 24, days: 5, deep_per_day: i * 30 }))],
    ['비율이 NaN', all24({ deep_ratio: NaN, active_sec: NaN, days: 1 })],
  ]) {
    render(`rhythmChart/${label}`, () => charts.rhythmChart(hours));
    render(`rhythmChart/${label}/구간강조`, () => charts.rhythmChart(hours, {
      highlight: { start_hour: 9, end_hour: 12 },
    }));
  }

  for (const [label, weekdays] of [
    ['빈 목록', []],
    ['기록 없음', Array.from({ length: 7 }, (_, i) => weekday(i))],
    ['비율이 NaN', Array.from({ length: 7 }, (_, i) => weekday(i, { deep_ratio: NaN, days: 2 }))],
  ]) {
    render(`weekdayChart/${label}`, () => charts.weekdayChart(weekdays));
  }

  // `/api/report/day` 의 hourly.
  for (const [label, hourly] of [
    ['빈 목록', []],
    ['전부 0', Array.from({ length: 24 }, (_, i) => ({ hour: i, active: 0, idle: 0 }))],
    ['정상', Array.from({ length: 24 }, (_, i) => ({ hour: i, active: i * 60, idle: 0 }))],
    ['값이 NaN', Array.from({ length: 24 }, (_, i) => ({ hour: i, active: NaN, idle: null }))],
  ]) {
    render(`hourHeatmap/${label}`, () => charts.hourHeatmap(hourly));
  }
});

/**
 * 받침대가 진짜로 무언가를 그리고 있는지.
 *
 * 위 검사들은 "나온 글자에 NaN 이 없다" 를 본다. 받침대가 고장 나 늘 빈 문자열을
 * 내놓아도 전부 통과한다 — 그러면 이 파일은 아무것도 지키지 않으면서 통과한다.
 */
test('받침대가 실제로 그림을 만들어 낸다', () => {
  const html = charts.barList(
    [{ name: '개발', seconds: 3600, color: '#4f9d69' }],
    { total: 7200 },
  ).outerHTML;
  assert.match(html, /개발/, '이름이 들어가지 않았습니다');
  assert.match(html, /1시간/, '시간 표기가 들어가지 않았습니다');
  assert.match(html, /50%/, '합계 대비 비율이 들어가지 않았습니다');
  // 막대 길이는 합계가 아니라 **목록에서 가장 큰 값**에 맞춘다 — 여기서는 하나뿐이라 100%.
  assert.match(html, /width:100%/, '막대 길이가 스타일로 붙지 않았습니다');

  const ring = charts.scoreRing(75).outerHTML;
  assert.match(ring, /<svg/, 'SVG 가 아닙니다');
  assert.match(ring, /75/, '점수가 들어가지 않았습니다');
});
