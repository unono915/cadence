import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast } from '../lib/ui.js';
import { dur, pct } from '../lib/format.js';
import { store } from '../lib/store.js';

/**
 * 아직 분류되지 않은 앱 정리.
 *
 * 미분류로 남은 시간은 조용히 모든 지표를 깎는다 — 몰입도도, 방해 비율도, 프로젝트 배분도
 * 실제보다 작게 나온다. 그런데 그 사실은 화면 어디에도 드러나지 않는다.
 * 그래서 "시간이 큰 것부터, 한 번 눌러 규칙으로 굳히는" 자리를 따로 만든다.
 *
 * 개별 기록을 고치는 것이 아니라 **규칙을 만들어** 과거와 미래를 함께 정리한다 —
 * 같은 앱을 매번 다시 분류하게 만들면 아무도 쓰지 않는다.
 *
 * 다만 브라우저처럼 **한 앱에서 여러 일을 하는 경우**는 앱 단위로 묶으면 안 된다.
 * "Chrome = 개발" 로 정하면 그 안에서 본 유튜브까지 몰입 시간이 되어 지표가 통째로 망가진다.
 * 그런 앱은 창 제목별로 나누도록 유도한다.
 */

/**
 * 빠른 버튼에 올릴 종류. 종류마다 하나씩만 뽑는다 —
 * '몰입'에 속한 카테고리가 여럿이라 그냥 앞에서 자르면 몰입만 다섯 개가 나온다.
 */
const QUICK_KINDS = ['deep', 'comms', 'meeting', 'shallow', 'distraction'];

function quickCategories() {
  return QUICK_KINDS
    .map((kind) => store.categories.find((c) => c.kind === kind))
    .filter(Boolean);
}

/**
 * 규칙 패턴의 최대 길이. 서버가 200자까지만 받는다.
 *
 * 창 제목은 400자까지 저장되므로, 긴 제목을 그대로 규칙으로 만들면 거절당한다 —
 * 사용자는 정리하려고 눌렀는데 빨간 오류만 본다. 앞부분만 잘라도 **그 제목은 그대로
 * 잡힌다**(부분 일치라서). 오히려 비슷한 제목까지 함께 잡혀 쓸모가 늘어난다.
 */
const MAX_PATTERN = 200;

async function makeRule({ field, pattern, categoryId }) {
  const res = await api.post('/api/rules', {
    field,
    pattern: pattern.slice(0, MAX_PATTERN),
    category_id: categoryId,
    priority: field === 'title' ? 50 : 90,
    apply_existing: true,
  });
  return res.updated;
}

export function unclassifiedCard(data, { onChange } = {}) {
  if (!data || !data.apps.length) return null;

  const quick = quickCategories();

  const rows = data.apps.map((a) => h('div.row.wrap', {
    style: {
      padding: '7px 9px', borderRadius: 'var(--radius-sm)',
      background: 'var(--panel-2)', gap: '6px', fontSize: '13px',
    },
  },
    h('div', { style: { minWidth: '150px', flex: 1 } },
      h('div.nowrap', a.app),
      a.sample_title
        ? h('div.muted.nowrap', { style: { fontSize: '11px' }, title: a.sample_title },
            a.mixed ? `${a.sample_title} 외 ${a.distinct_titles - 1}종` : a.sample_title)
        : null,
    ),
    h('span.mono.muted', { style: { minWidth: '54px' } }, dur(a.seconds)),

    // 한 앱에서 여러 일을 한 경우에는 앱 단위 버튼을 아예 주지 않는다.
    // 한 번의 잘못된 클릭이 과거 기록까지 통째로 물들이기 때문.
    ...(a.mixed
      ? [
          h('span.tag', { style: { color: 'var(--warn)' } }, `창 제목 ${a.distinct_titles}종`),
          h('button.btn.sm.primary', {
            onclick: () => openTitleSplit(a, onChange),
          }, '제목별로 나누기'),
        ]
      : [
          ...quick.map((c) => h('button.btn.sm', {
            onclick: async () => {
              const updated = await makeRule({ field: 'app', pattern: a.app, categoryId: c.id });
              toast(`"${a.app}" 규칙을 만들고 기존 기록 ${updated}건을 정리했습니다`, 'ok');
              onChange?.();
            },
            title: `"${a.app}" 을(를) 항상 ${c.name}(으)로`,
          }, c.name)),
          h('button.btn.sm.ghost', {
            onclick: () => openTitleSplit(a, onChange),
            title: '창 제목으로 나누기',
            'aria-label': `${a.app}: 창 제목으로 나누기`,
          }, '⋯'),
        ]),
  ));

  return h('div.card', { style: { borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' } },
    h('h2', '분류가 필요한 앱',
      h('span.sub', `최근 ${data.days}일 중 ${dur(data.unclassified_sec)} · 활동의 ${pct(data.unclassified_sec, data.active_sec)}%`),
    ),
    h('div.muted', { style: { fontSize: '12px', marginBottom: '9px' } },
      '미분류로 남은 시간은 몰입도·방해 비율 계산에서 통째로 빠집니다. 한 번 눌러 두면 규칙이 되어 과거 기록까지 정리되고, 다음부터는 자동으로 분류됩니다.'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } }, rows),
  );
}

/**
 * 창 제목별로 나눠 분류한다.
 *
 * 브라우저 한 줄을 통째로 "개발"로 만들면 그 안의 유튜브까지 몰입이 된다.
 * 제목별로 정하면 같은 앱 안에서도 갈라진다 — 이게 이 도구의 분류가 쓸모 있어지는 지점이다.
 */
/**
 * 시간이 가장 큰 미분류 앱을 바로 연다.
 *
 * 오늘 화면의 읽을거리는 "활동의 64%가 미분류입니다" 라고 말한 뒤 타임라인으로만 보냈다.
 * 거기서 다시 카드를 찾아 "제목별로 나누기" 를 눌러야 실제로 정리가 시작된다 —
 * 이 앱에서 가장 값진 동작인데 가는 길이 가장 길었다. 한 번에 그 자리로 데려다 준다.
 */
export function openLargestUnclassified(data, onChange) {
  const app = data?.apps?.[0];
  if (!app) return false;
  openTitleSplit(app, onChange);
  return true;
}

function openTitleSplit(app, onChange) {
  openModal((close) => {
    const quick = quickCategories();
    const titles = app.top_titles || [];
    const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } });
    const done = new Set();

    // 되풀이되는 낱말로 만드는 규칙 — 제목 하나하나보다 이쪽이 오래 간다.
    const suggestEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } });
    const suggestWrap = h('div', { hidden: true },
      h('div.section-title', { style: { marginTop: '2px' } }, '되풀이되는 낱말'),
      h('div.muted', { style: { fontSize: '11px', marginBottom: '6px' } },
        '여러 제목에 함께 나오는 조각입니다. 제목 하나를 정하면 그 제목만 정리되지만, '
        + '이쪽으로 규칙을 만들면 앞으로 생길 제목까지 함께 잡습니다.'),
      suggestEl,
    );

    async function loadSuggestions() {
      let data;
      try {
        data = await api.get('/api/activity/title-suggestions', { app: app.app });
      } catch {
        return;
      }
      if (!data.suggestions.length) return;
      suggestWrap.hidden = false;
      const paintSuggestions = () => {
        suggestEl.replaceChildren(...data.suggestions.map((sug) => h('div.row.wrap', {
          style: {
            padding: '6px 9px', borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-2)', gap: '6px', fontSize: '12px',
            opacity: done.has(sug.token) ? 0.45 : 1,
          },
        },
          h('div', { style: { flex: 1, minWidth: '140px' } },
            h('div.nowrap', { title: sug.sample }, `"${sug.token}"`),
            h('div.muted', { style: { fontSize: '10px' } },
              `${dur(sug.seconds)} · 제목 ${sug.titles}개 · 미분류의 ${Math.round(sug.share * 100)}%`),
          ),
          done.has(sug.token)
            ? h('span.tag', { style: { color: 'var(--good)' } }, '완료')
            : quick.map((c) => h('button.btn.sm', {
                onclick: async () => {
                  const updated = await makeRule({ field: 'title', pattern: sug.token, categoryId: c.id });
                  done.add(sug.token);
                  paintSuggestions();
                  paint();
                  toast(`"${sug.token}" → ${c.name} · ${updated}건 정리`, 'ok', 2200);
                },
              }, c.name)),
        )));
      };
      paintSuggestions();
    }
    loadSuggestions();

    function paint() {
      listEl.replaceChildren(...titles.map((t) => h('div.row.wrap', {
        style: {
          padding: '6px 9px', borderRadius: 'var(--radius-sm)',
          background: 'var(--panel-2)', gap: '6px', fontSize: '12px',
          opacity: done.has(t.title) ? 0.45 : 1,
        },
      },
        h('div.nowrap', { style: { flex: 1, minWidth: '140px' }, title: t.title }, t.title),
        h('span.mono.muted', { style: { minWidth: '48px' } }, dur(t.seconds)),
        done.has(t.title)
          ? h('span.tag', { style: { color: 'var(--good)' } }, '완료')
          : quick.map((c) => h('button.btn.sm', {
              onclick: async () => {
                const updated = await makeRule({ field: 'title', pattern: t.title, categoryId: c.id });
                done.add(t.title);
                paint();
                toast(`"${t.title.slice(0, 24)}" → ${c.name} · ${updated}건 정리`, 'ok', 2200);
              },
            }, c.name)),
      )));

      if (!titles.length) {
        listEl.replaceChildren(h('div.empty',
          '이 앱에는 저장된 창 제목이 없습니다. 설정에서 창 제목 수집이 꺼져 있는지 확인해 보세요.'));
      }
    }
    paint();

    const fallback = h('select',
      h('option', { value: '' }, '고르지 않음'),
      store.categories.map((c) => h('option', { value: c.id }, c.name)),
    );

    return {
      title: `${app.app} — 창 제목별 분류`,
      body: [
        h('div.hint',
          h('span.icon', '!'),
          h('span',
            `이 앱에서는 창 제목이 ${app.distinct_titles}가지로 나뉩니다. 앱 하나로 묶어 분류하면 `,
            h('b', '그 안에서 한 다른 일까지 같은 분류가 됩니다'),
            ' — 브라우저를 "개발"로 정하면 거기서 본 영상까지 몰입 시간이 됩니다.'),
        ),
        suggestWrap,
        h('div.section-title', { style: { marginTop: '2px' } }, '제목 하나씩'),
        h('div.muted', { style: { fontSize: '12px' } },
          `오래 머문 제목부터 ${titles.length}개입니다. 각각 눌러 두면 규칙이 되어 과거 기록까지 함께 정리됩니다.`),
        listEl,
        h('div', { style: { borderTop: '1px solid var(--border-soft)', paddingTop: '10px' } },
          h('label.field',
            '나머지 전부를 한 분류로 (선택)',
            fallback,
            h('span', { style: { fontSize: '11px' } },
              '위에서 정하지 않은 나머지 시간에 적용할 앱 단위 규칙입니다. 우선순위가 낮아 제목 규칙이 먼저 적용됩니다.'),
          ),
        ),
      ],
      footer: [
        h('button.btn', { onclick: close }, '닫기'),
        h('button.btn.primary', {
          onclick: async () => {
            if (fallback.value) {
              const updated = await makeRule({
                field: 'app', pattern: app.app, categoryId: Number(fallback.value),
              });
              toast(`나머지 ${updated}건을 정리했습니다`, 'ok');
            }
            close();
            onChange?.();
          },
        }, '마치기'),
      ],
    };
  });
}
