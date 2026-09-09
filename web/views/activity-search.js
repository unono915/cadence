import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal } from '../lib/ui.js';
import { dur, hhmm, dayLabel } from '../lib/format.js';
import { setDay } from '../lib/store.js';

/**
 * 기간 전체 활동 검색.
 *
 * "그 문서 언제 만졌더라", "이 건에 몇 시간 썼지" — 타임시트를 되짚거나 근거를 대야 할 때
 * 필요한 질문이다. 날짜별 합계로 접어 보여 주고, 날짜를 누르면 그날 타임라인으로 넘어간다.
 */
/**
 * 눌러서 넘어가는 줄. **버튼으로 만든다.**
 *
 * `div` 에 `onclick` 만 달면 마우스로는 되지만 키보드로는 닿지도, 누르지도 못한다 —
 * 화면 낭독기에서는 그냥 글 덩어리라 "누를 수 있다" 는 사실 자체가 전달되지 않는다.
 * 생김새는 그대로 두고 역할만 버튼으로 바꾼다.
 */
function rowButton(props, ...children) {
  return h('button', {
    type: 'button',
    ...props,
    style: {
      display: 'flex', width: '100%', textAlign: 'left', background: 'none',
      border: 'none', font: 'inherit', color: 'inherit', cursor: 'pointer',
      ...(props.style || {}),
    },
  }, ...children);
}

export function openActivitySearch(initialQuery = '') {
  openModal((close) => {
    const input = h('input', {
      type: 'search', placeholder: '창 제목·앱 이름·메모 (예: 분기 보고서, Figma, 약속)',
      value: initialQuery, autofocus: true,
    });
    const summary = h('div.muted', { style: { fontSize: '12px' } }, '검색어를 입력하세요.');
    const results = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } });

    let timer = null;
    let lastQuery = '';

    async function run() {
      const q = input.value.trim();
      if (q === lastQuery) return;
      lastQuery = q;
      if (q.length < 2) {
        summary.textContent = '두 글자 이상 입력하세요.';
        clear(results);
        return;
      }
      const data = await api.get('/api/activity/search', { q });
      if (input.value.trim() !== q) return; // 늦게 도착한 응답은 버린다

      const noteCount = (data.notes || []).reduce((n, x) => n + x.lines.length, 0);
      summary.textContent = data.matches || noteCount
        ? [
            data.matches ? `${data.days.length}일 · ${data.matches}건 · 합계 ${dur(data.total_sec)}` : null,
            noteCount ? `메모 ${noteCount}줄` : null,
          ].filter(Boolean).join(' · ') + (data.truncated ? ' (500건까지만)' : '')
        : '일치하는 기록이 없습니다.';

      clear(results);

      // 메모를 먼저 보여 준다 — 사람이 직접 쓴 문장이라, 찾는 답이 여기 있을 때가 많다.
      if ((data.notes || []).length) {
        results.append(h('div',
          h('div.section-title', { style: { marginTop: 0 } }, '메모'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            data.notes.map((n) => rowButton({
              style: {
                flexDirection: 'column', alignItems: 'stretch',
                padding: '6px 9px', borderRadius: 'var(--radius-sm)',
                background: 'var(--panel-2)', fontSize: '12px',
              },
              onclick: () => { setDay(n.day); location.hash = '#/today'; close(); },
              title: '이 날의 오늘 화면으로 이동',
              'aria-label': `${dayLabel(n.day)} 메모 — 그날 화면으로 이동`,
            },
              h('div.muted', { style: { fontSize: '11px', marginBottom: '2px' } }, dayLabel(n.day)),
              n.lines.map((line) => h('div', { style: { wordBreak: 'break-word' } }, line)),
            )),
          ),
        ));
      }

      for (const day of data.days) {
        results.append(h('div',
          rowButton({
            class: 'row',
            style: {
              justifyContent: 'space-between',
              padding: '4px 0', borderBottom: '1px solid var(--border-soft)', marginBottom: '4px',
            },
            onclick: () => { setDay(day.day); location.hash = '#/timeline'; close(); },
            title: '이 날의 타임라인으로 이동',
            'aria-label': `${dayLabel(day.day)} — 그날 타임라인으로 이동`,
          },
            h('span', { style: { fontWeight: 500 } }, dayLabel(day.day)),
            h('span.muted.mono', dur(day.seconds)),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
            day.items.map((item) => h('div.row', { style: { fontSize: '12px', gap: '8px' } },
              h('span.mono.muted', { style: { minWidth: '40px' } }, hhmm(item.started_at)),
              h('span.mono.muted', { style: { minWidth: '48px' } }, dur(item.seconds)),
              h('span.tag', h('span.swatch', { style: { background: item.category_color } }), item.category_name),
              h('span.nowrap', { style: { flex: 1 }, title: `${item.app} — ${item.title}` },
                item.title || item.app),
            )),
          ),
        ));
      }
    }

    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 260);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(timer); run(); }
    });
    if (initialQuery) setTimeout(run, 60);

    return {
      title: '활동 검색',
      body: [input, summary, results],
    };
  });
}
