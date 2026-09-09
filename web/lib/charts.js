import { h, svg } from './dom.js';
import { dur, hhmm, pct } from './format.js';

/**
 * 그릴 수 있는 숫자로 만든다.
 *
 * 좌표·너비·투명도에 숫자가 아닌 값이 들어가면 브라우저는 그 속성을 **조용히 버린다.**
 * 예외도 경고도 없고, 그 자리만 빈 채로 화면이 뜬다. 게다가 `Math.max` 는 NaN 하나에
 * 통째로 물들기 때문에, 이상한 값 하나가 **그 그림 전체**를 지워 버린다.
 * 그릴 수 없는 값은 0 으로 본다 — 없는 것으로 그리는 편이, 아무것도 안 그리는 것보다 낫다.
 */
const num = (v) => (Number.isFinite(v) ? v : 0);

/** 점수 링. 0~100 을 원호로 그리고 가운데에 숫자를 넣는다. */
export function scoreRing(score, { size = 108, stroke = 9, label = 'Cadence', muted = false } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = muted ? 0 : Math.max(0, Math.min(100, score || 0));
  const color = muted
    ? 'var(--panel-3)'
    : clamped >= 70 ? 'var(--good)' : clamped >= 40 ? 'var(--warn)' : 'var(--bad)';

  return svg('svg.score-ring', {
    viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img',
    'aria-label': `${label} ${clamped}점`,
  },
    svg('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none',
      stroke: 'var(--panel-3)', 'stroke-width': stroke,
    }),
    svg('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none',
      stroke: color, 'stroke-width': stroke, 'stroke-linecap': 'round',
      'stroke-dasharray': `${(c * clamped) / 100} ${c}`,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
      style: 'transition: stroke-dasharray .5s ease',
    }),
    svg('text', {
      x: size / 2, y: size / 2 + 1, 'text-anchor': 'middle', 'dominant-baseline': 'middle',
      style: `fill: ${muted ? 'var(--muted)' : 'var(--text)'}; font-size: ${size * 0.28}px; font-weight: 650;`,
    }, muted ? '—' : String(clamped)),
    svg('text', {
      x: size / 2, y: size / 2 + size * 0.21, 'text-anchor': 'middle',
      style: 'fill: var(--muted); font-size: 10px;',
    }, '/ 100'),
  );
}

/** 카테고리 도넛. items: [{name, color, seconds}] */
export function donut(items, { size = 150, stroke = 22 } = {}) {
  const total = items.reduce((s, i) => s + num(i.seconds), 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  if (!total) {
    return svg('svg.chart', { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
      svg('circle', { cx: size / 2, cy: size / 2, r, fill: 'none', stroke: 'var(--panel-2)', 'stroke-width': stroke }),
      svg('text', { x: size / 2, y: size / 2, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, '기록 없음'),
    );
  }

  let offset = 0;
  const arcs = items.map((item) => {
    const len = (num(item.seconds) / total) * c;
    const arc = svg('circle', {
      cx: size / 2, cy: size / 2, r, fill: 'none',
      stroke: item.color, 'stroke-width': stroke,
      'stroke-dasharray': `${Math.max(0, len - 1.5)} ${c}`,
      'stroke-dashoffset': -offset,
      transform: `rotate(-90 ${size / 2} ${size / 2})`,
    }, svg('title', `${item.name} · ${dur(item.seconds)} (${pct(item.seconds, total)}%)`));
    offset += len;
    return arc;
  });

  return svg('svg.chart', { viewBox: `0 0 ${size} ${size}`, width: size, height: size },
    ...arcs,
    svg('text', {
      x: size / 2, y: size / 2 - 5, 'text-anchor': 'middle',
      style: 'fill: var(--text); font-size: 17px; font-weight: 620;',
    }, dur(total, { compact: true })),
    svg('text', { x: size / 2, y: size / 2 + 12, 'text-anchor': 'middle' }, '활동 시간'),
  );
}

/** 도넛 옆에 붙이는 범례. */
export function legend(items, total) {
  return h('div.legend',
    items.map((i) => h('div.item',
      h('span.swatch', { style: { background: i.color || 'var(--accent)' } }),
      h('span', i.name),
      h('span.amt', `${dur(i.seconds)}${total ? ` · ${pct(i.seconds, total)}%` : ''}`),
    )),
  );
}

/** 가로 막대 목록 (HTML). items: [{name, seconds, color?}] */
export function barList(items, { total, max, onClick, suffix } = {}) {
  const cap = max ?? Math.max(1, ...items.map((i) => num(i.seconds)));
  return h('div.bar-list',
    // 누를 수 있는 줄은 **버튼으로** 만든다. `div` 에 onclick 만 달면 마우스로는 되지만
    // 키보드로는 닿지도 누르지도 못하고, 낭독기에는 "누를 수 있다" 는 사실이 전달되지 않는다.
    items.map((i) => h(onClick ? 'button.bar-row' : 'div.bar-row', {
      type: onClick ? 'button' : null,
      onclick: onClick ? () => onClick(i) : null,
      title: i.title || i.name,
      'aria-label': onClick ? `${i.name} — 자세히 보기` : null,
    },
      h('span.name', i.name),
      h('span.amt', `${dur(i.seconds)}${total ? ` · ${pct(i.seconds, total)}%` : ''}${suffix ? suffix(i) : ''}`),
      h('span.track', h('i', {
        style: { width: `${Math.max(2, (num(i.seconds) / cap) * 100)}%`, background: i.color || 'var(--accent)' },
      })),
    )),
  );
}

/**
 * 하루 타임라인 띠. segments: [{started_at, ended_at, category_color, idle, app, title, category_name}]
 * 시간축 눈금과 몰입 블록 표시를 함께 그린다.
 */
export function timelineStrip(segments, { blocks = [], height = 46, onPick, onRange, showNow = false } = {}) {
  const active = segments.filter((s) => s.seconds > 0);
  if (!active.length) return h('div.empty', '오늘 기록된 활동이 없습니다');

  const first = Math.min(...active.map((s) => s.started_at));
  const last = Math.max(...active.map((s) => s.ended_at));
  const startHour = new Date(first);
  startHour.setMinutes(0, 0, 0);
  const endHour = new Date(last);
  endHour.setHours(endHour.getHours() + 1, 0, 0, 0);
  const t0 = startHour.getTime();
  const t1 = Math.max(endHour.getTime(), t0 + 3600_000);
  const span = t1 - t0;

  const W = 1000;
  const barTop = 14;
  const barH = height - 26;
  const x = (t) => ((t - t0) / span) * W;

  const ticks = [];
  for (let t = t0; t <= t1; t += 3600_000) {
    const hours = (t1 - t0) / 3600_000;
    const step = hours > 14 ? 2 : 1;
    if (new Date(t).getHours() % step !== 0) continue;
    ticks.push(svg('g', {},
      svg('line', { x1: x(t), x2: x(t), y1: barTop, y2: barTop + barH, class: 'grid-line', opacity: 0.5 }),
      svg('text', { x: x(t) + 3, y: 10, style: 'fill: var(--muted); font-size: 9px;' }, hhmm(t)),
    ));
  }

  const bars = active.map((s) => {
    const w = Math.max(0.6, x(s.ended_at) - x(s.started_at));
    return svg('rect', {
      x: x(s.started_at), y: barTop, width: w, height: barH, rx: 1,
      fill: s.idle ? 'var(--panel-3)' : (s.category_color || 'var(--muted)'),
      opacity: s.idle ? 0.55 : 0.92,
      style: onPick ? 'cursor: pointer' : '',
      // 끌어서 구간을 고른 직후에는 클릭이 한 번 더 들어온다. 그때 상세 창이 열리면
      // 방금 고른 구간이 가려져 버리므로, 드래그로 끝난 동작은 클릭으로 세지 않는다.
      onclick: onPick ? () => { if (!drag.moved) onPick(s); } : null,
    }, svg('title', `${hhmm(s.started_at)}–${hhmm(s.ended_at)} · ${s.app}${s.title ? ` — ${s.title}` : ''}\n${s.category_name || ''} · ${dur(s.seconds)}`));
  });

  const blockMarks = blocks.map((b) => svg('rect', {
    x: x(b.start), y: barTop + barH + 2, width: Math.max(1, x(b.end) - x(b.start)), height: 3, rx: 1.5,
    fill: 'var(--good)',
  }, svg('title', `몰입 블록 ${dur(b.deep_sec)} · ${b.top_app}`)));

  // 오늘을 볼 때는 "지금 어디쯤인가"를 표시한다 — 남은 시간이 한눈에 보이도록.
  const now = Date.now();
  const nowMark = showNow && now >= t0 && now <= t1
    ? svg('g', {},
        svg('line', {
          x1: x(now), x2: x(now), y1: 2, y2: barTop + barH + 5,
          stroke: 'var(--text)', 'stroke-width': 1.2, opacity: 0.75,
        }, svg('title', `지금 ${hhmm(now)}`)),
        svg('circle', { cx: x(now), cy: 3, r: 2.5, fill: 'var(--text)', opacity: 0.75 }),
      )
    : null;

  // 끌어서 시간 구간을 고르는 상태. 막대의 onclick 이 이 값을 본다.
  const drag = { from: null, moved: false };
  const selection = svg('rect', {
    x: 0, y: barTop, width: 0, height: barH, rx: 1,
    fill: 'var(--accent)', opacity: 0.3, style: 'pointer-events: none',
  });
  const selectionLabel = svg('text', {
    x: 0, y: 10, style: 'fill: var(--accent); font-size: 9px; pointer-events: none;',
  }, '');

  const root = svg('svg.timeline-strip', {
    viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', height,
  }, ...ticks, ...bars, ...blockMarks, selection, selectionLabel, nowMark);

  // 끌어서 구간 고르기.
  //
  // 구간 지정 창에 시각을 손으로 입력하게 하면, 눈앞에 막대가 있는데도 숫자를 옮겨 적어야 한다.
  // 여기서 바로 그으면 그 자리가 그대로 구간이 된다 — 타임라인이 있는 이유가 그것이다.
  if (onRange) {
    root.style.cursor = 'crosshair';
    root.style.touchAction = 'none';

    const timeAt = (clientX) => {
      const r = root.getBoundingClientRect();
      if (!r.width) return t0;
      const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
      return t0 + ratio * span;
    };
    const paint = (a, b) => {
      selection.setAttribute('x', x(a));
      selection.setAttribute('width', Math.max(1, x(b) - x(a)));
      selectionLabel.setAttribute('x', Math.min(W - 90, x(a) + 3));
      selectionLabel.textContent = `${hhmm(a)}–${hhmm(b)}`;
    };
    const clear = () => {
      selection.setAttribute('width', 0);
      selectionLabel.textContent = '';
    };

    root.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag.from = timeAt(e.clientX);
      drag.moved = false;
      try { root.setPointerCapture(e.pointerId); } catch { /* 캡처가 막혀도 동작은 한다 */ }
    });

    root.addEventListener('pointermove', (e) => {
      if (drag.from === null) return;
      const t = timeAt(e.clientX);
      // 손이 살짝 떨린 것까지 드래그로 보면 클릭이 아예 안 된다.
      if (!drag.moved && Math.abs(t - drag.from) < span * 0.004) return;
      drag.moved = true;
      paint(Math.min(drag.from, t), Math.max(drag.from, t));
    });

    const finish = (e) => {
      if (drag.from === null) return;
      const t = timeAt(e.clientX);
      const a = Math.round(Math.min(drag.from, t));
      const b = Math.round(Math.max(drag.from, t));
      drag.from = null;
      clear();
      if (!drag.moved) return;
      onRange(a, b);
      // 이어서 들어오는 click 이벤트까지는 '드래그였다'로 남겨 둔다.
      setTimeout(() => { drag.moved = false; }, 0);
    };
    root.addEventListener('pointerup', finish);
    root.addEventListener('pointercancel', () => { drag.from = null; drag.moved = false; clear(); });
  }

  return root;
}

/**
 * 세로 막대 추세. data: [{day, ...}], series: [{key, color, label}]
 * 스택 막대로 그린다.
 */
export function trendChart(data, series, {
  height = 170,
  valueFormat = (v) => dur(v, { compact: true }),
  yLabel,
  emptyText = '아직 그릴 기록이 없습니다',
} = {}) {
  const W = 900;
  const padL = 42;
  const padB = 22;
  const padT = 8;
  const plotW = W - padL - 8;
  const plotH = height - padB - padT;

  const totals = data.map((d) => series.reduce((s, k) => s + (d[k.key] || 0), 0));
  // 값이 하나도 없으면 눈금이 '1초' 같은 무의미한 숫자로 채워진다. 그럴 바엔 비워 두는 게 낫다.
  if (!totals.some((t) => t > 0)) return h('div.empty', emptyText);

  const max = Math.max(1, ...totals);
  const bw = Math.max(3, (plotW / Math.max(1, data.length)) * 0.62);
  const step = plotW / Math.max(1, data.length);

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((f) => {
    const y = padT + plotH - f * plotH;
    return svg('g', {},
      svg('line', { x1: padL, x2: W - 8, y1: y, y2: y, class: 'grid-line' }),
      svg('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end' }, f === 0 ? '0' : valueFormat(max * f)),
    );
  });

  const bars = data.map((d, i) => {
    const cx = padL + step * i + step / 2;
    let acc = 0;
    const parts = series.map((s) => {
      const v = d[s.key] || 0;
      if (v <= 0) return null;
      const hh = (v / max) * plotH;
      const y = padT + plotH - acc - hh;
      acc += hh;
      return svg('rect', {
        x: cx - bw / 2, y, width: bw, height: Math.max(1, hh), rx: 1.5, fill: s.color,
      }, svg('title', `${d.day} · ${s.label} ${valueFormat(v)}`));
    });
    const label = data.length <= 16 || i % 2 === 0
      // 날짜가 비어 있으면 `.slice` 에서 예외가 나고, 그러면 눈금 하나가 아니라
      // **리포트 화면 전체**가 뜨지 않는다. 이름표 하나 없는 편이 훨씬 낫다.
      ? svg('text', { x: cx, y: height - 6, 'text-anchor': 'middle' }, String(d.day || '').slice(5).replace('-', '/'))
      : null;
    return svg('g', {}, ...parts.filter(Boolean), label);
  });

  return svg('svg.chart', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', height },
    ...gridLines, ...bars,
    yLabel ? svg('text', { x: padL - 6, y: padT - 1, 'text-anchor': 'end' }, yLabel) : null,
  );
}

/**
 * 시간대별 몰입 비율. 막대 높이는 "그 시간에 자리에 있었을 때 몰입한 비율",
 * 옅은 배경은 그 시간대에 앉아 있던 시간(표본의 두께)을 나타낸다.
 * 표본이 얇은 시간대는 흐리게 그려 과잉 해석을 막는다.
 */
export function rhythmChart(hours, { height = 130, highlight = null } = {}) {
  const W = 960;
  const padB = 18;
  const padT = 6;
  const plotH = height - padB - padT;
  const cw = W / 24;
  const maxActive = Math.max(1, ...hours.map((x) => num(x.active_sec)));

  const bars = hours.map((x, i) => {
    const ratio = num(x.deep_ratio);
    const barH = ratio * plotH;
    const thin = x.days < 3;
    const inWindow = highlight && i >= highlight.start_hour && i < highlight.end_hour;
    return svg('g', {},
      // 표본 두께 — 배경 막대
      svg('rect', {
        x: i * cw + 1.5, y: padT, width: cw - 3, height: plotH, rx: 2,
        fill: 'var(--panel-2)',
        opacity: 0.35 + (num(x.active_sec) / maxActive) * 0.45,
      }),
      svg('rect', {
        x: i * cw + 1.5, y: padT + plotH - barH, width: cw - 3, height: Math.max(0, barH), rx: 2,
        fill: inWindow ? 'var(--good)' : 'var(--accent)',
        opacity: thin ? 0.3 : 0.9,
      }, svg('title',
        `${i}시 — 몰입 비율 ${Math.round(ratio * 100)}% · 하루 평균 몰입 ${dur(x.deep_per_day)} · 관측 ${x.days}일${thin ? ' (표본 부족)' : ''}`)),
      i % 3 === 0
        ? svg('text', { x: i * cw + cw / 2, y: height - 5, 'text-anchor': 'middle' }, `${i}`)
        : null,
    );
  });

  return svg('svg.chart', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', height }, ...bars);
}

/** 요일별 몰입 비율 — 가로 막대. */
export function weekdayChart(weekdays) {
  const max = Math.max(0.01, ...weekdays.map((d) => num(d.deep_ratio)));
  return h('div.bar-list',
    weekdays.map((d) => h('div.bar-row', { title: `관측 ${d.days}일` },
      h('span.name', d.label),
      h('span.amt', d.days
        ? `${Math.round(num(d.deep_ratio) * 100)}% · 하루 ${dur(d.deep_per_day)}`
        : '기록 없음'),
      h('span.track', h('i', {
        style: {
          width: `${Math.max(2, (num(d.deep_ratio) / max) * 100)}%`,
          background: 'var(--accent)',
          opacity: d.days >= 2 ? 1 : 0.35,
        },
      })),
    )),
  );
}

/** 시간대별 활동 밀도 히트맵 (0~23시). */
export function hourHeatmap(hourly, { height = 54 } = {}) {
  const W = 960;
  const max = Math.max(1, ...hourly.map((b) => num(b.active)));
  const cw = W / 24;
  return svg('svg.chart', { viewBox: `0 0 ${W} ${height}`, preserveAspectRatio: 'none', height },
    ...hourly.map((b, i) => {
      const intensity = num(b.active) / max;
      return svg('g', {},
        svg('rect', {
          x: i * cw + 1, y: 4, width: cw - 2, height: height - 22, rx: 3,
          fill: 'var(--accent)',
          opacity: b.active ? 0.14 + intensity * 0.8 : 0.06,
        }, svg('title', `${i}시 · 활동 ${dur(b.active)}${b.idle ? ` · 자리비움 ${dur(b.idle)}` : ''}`)),
        i % 3 === 0
          ? svg('text', { x: i * cw + cw / 2, y: height - 4, 'text-anchor': 'middle' }, `${i}`)
          : null,
      );
    }),
  );
}
