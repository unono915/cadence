import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast } from '../lib/ui.js';
import { dur, hhmm } from '../lib/format.js';
import { store } from '../lib/store.js';
import { LIMITS } from '../lib/limits.js';

/**
 * 자리비움 되묻기.
 *
 * 자동 추적은 화면 앞을 떠난 시간을 전부 "자리비움"으로 남긴다. 하지만 그 시간의 상당 부분은
 * 회의·통화·종이 검토처럼 엄연한 업무다. 그대로 두면 하루가 실제보다 비어 보이고,
 * 회의 부담 같은 중요한 신호가 통째로 사라진다.
 *
 * 그래서 긴 구간만 골라 한 번씩 되묻는다. 한 번 확인한 구간은 다시 묻지 않는다.
 */

/** 아무 기록도 없는 첫날에 쓰는 기본 버튼. */
const QUICK = [
  { label: '회의', category: '회의', app: '회의' },
  { label: '오프라인 작업', category: '설계·리서치', app: '오프라인 작업' },
  { label: '학습·읽기', category: '학습', app: '오프라인 읽기' },
  { label: '식사·휴식', category: '휴식', app: '휴식' },
];

/** 한 줄에 놓을 빠른 버튼 수. 넷을 넘기면 줄이 접히고 고르기가 오히려 느려진다. */
const QUICK_MAX = 4;

/**
 * 그 사람이 실제로 쓰는 이름표를 앞에 세운다.
 *
 * 자리를 비우는 이유는 직업마다 다르다 — 교사에게는 대부분이 '수업' 이고 영업에게는 '외근' 이다.
 * 기본 넷만 두면 그런 사람은 매번 "직접 입력" 을 눌러 같은 말을 다시 적어야 하고,
 * 하루에 여덟 구간이면 그 순간 이 기능은 안 쓰이게 된다.
 *
 * 카테고리가 없어진 기본 버튼은 뺀다 — 눌러도 미분류가 되는 버튼은 없느니만 못하다.
 */
function quickButtons(labels, catId) {
  const used = (labels || [])
    .filter((l) => l.category_id)
    .map((l) => ({ label: l.app, category_id: l.category_id, app: l.app }));

  const seen = new Set(used.map((u) => u.app));
  const defaults = QUICK
    .map((q) => ({ label: q.label, category_id: catId(q.category), app: q.app }))
    .filter((q) => q.category_id && !seen.has(q.app));

  return [...used, ...defaults].slice(0, QUICK_MAX);
}

/** 한 번에 보여줄 구간 수. 목록이 길어지면 확인 자체가 부담이 되므로 조금씩 처리하게 한다. */
const VISIBLE = 3;

export function gapsCard(gaps, { onChange, labels } = {}) {
  if (!gaps.length) return null;

  const totalSec = gaps.reduce((s, g) => s + g.seconds, 0);
  const catId = (name) => store.categories.find((c) => c.name === name)?.id ?? null;
  const quick = quickButtons(labels, catId);
  let expanded = false;

  /**
   * 정리 요청. 누른 줄은 곧바로 잠근다.
   *
   * 목록은 서버가 답하고 화면이 다시 그려질 때까지 그대로 남아 있다. 그 사이에 같은 줄의
   * 다른 버튼을 누르면 — 마음이 바뀌어 "회의" 대신 "오프라인 작업" 을 누르는 흔한 경우 —
   * 이미 자리비움이 아니게 된 행에 다시 요청이 가고 "자리비움 기록이 아닙니다" 라는
   * 빨간 토스트를 보게 된다. 사용자는 아무것도 잘못하지 않았는데.
   */
  async function resolve(gap, body, row) {
    if (row) {
      for (const b of row.querySelectorAll('button')) b.disabled = true;
      row.style.opacity = '0.55';
    }
    try {
      await api.post(`/api/activity/${gap.id}/resolve`, body);
      onChange?.();
    } catch (err) {
      // 실패했으면 다시 눌러 볼 수 있어야 한다.
      if (row) {
        for (const b of row.querySelectorAll('button')) b.disabled = false;
        row.style.opacity = '';
      }
      throw err;
    }
  }

  const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } });

  const gapRow = (gap) => {
    const row = h('div.row.wrap', {
      style: {
        padding: '6px 9px', borderRadius: 'var(--radius-sm)', background: 'var(--panel-2)',
        gap: '6px', fontSize: '13px',
      },
    },
      h('span.mono', { style: { minWidth: '96px' } }, `${hhmm(gap.started_at)}–${hhmm(gap.ended_at)}`),
      h('span.muted', { style: { minWidth: '46px' } }, dur(gap.seconds)),
      h('div.spacer'),
      quick.map((q) => h('button.btn.sm', {
        onclick: () => resolve(gap, { app: q.app, category_id: q.category_id }, row),
        'aria-label': `${hhmm(gap.started_at)} 구간: ${q.label}`,
      }, q.label)),
      h('button.btn.sm.ghost', {
        onclick: () => openGapDetail(gap, onChange),
        title: '직접 입력', 'aria-label': `${hhmm(gap.started_at)} 구간: 직접 입력`,
      }, '⋯'),
      h('button.btn.sm.ghost', {
        onclick: () => resolve(gap, { ignore: true }, row),
        title: '자리비움이 맞습니다', 'aria-label': `${hhmm(gap.started_at)} 구간: 자리비움으로 확정`,
      }, '✓'),
    );
    return row;
  };

  const paint = () => {
    const shown = expanded ? gaps : gaps.slice(0, VISIBLE);
    listEl.replaceChildren(
      ...shown.map(gapRow),
      gaps.length > VISIBLE
        ? h('button.btn.ghost.sm', {
            style: { alignSelf: 'flex-start' },
            onclick: () => { expanded = !expanded; paint(); },
          }, expanded ? '접기' : `${gaps.length - VISIBLE}구간 더 보기`)
        : null,
    );
  };
  paint();

  return h('div.card', { style: { borderColor: 'color-mix(in srgb, var(--warn) 35%, transparent)' } },
    h('h2', '자리를 비운 시간',
      h('div.row',
        h('span.sub', `${gaps.length}구간 · ${dur(totalSec)}`),
        h('button.btn.sm.ghost', {
          title: '모두 자리비움으로 확정합니다',
          onclick: async () => {
            await Promise.all(gaps.map((g) => api.post(`/api/activity/${g.id}/resolve`, { ignore: true })));
            toast('모두 확인 처리했습니다', 'ok');
            onChange?.();
          },
        }, '전부 자리비움'),
      ),
    ),
    h('div.muted', { style: { fontSize: '12px', marginBottom: '9px' } },
      '회의나 오프라인 작업이었다면 표시해 두어야 하루가 제대로 계산됩니다. 한 번 확인한 구간은 다시 묻지 않습니다.'),
    listEl,
  );
}

function openGapDetail(gap, onChange) {
  openModal((close) => {
    const label = h('input', {
      type: 'text', placeholder: '예: 고객사 전화, 인쇄물 검토, 이동', maxlength: LIMITS.ACTIVITY_APP,
    });
    const cat = h('select',
      store.categories.map((c) => h('option', { value: c.id, selected: c.name === '회의' }, c.name)),
    );
    const taskSel = h('select', h('option', { value: '' }, '연결 없음'));

    api.get('/api/tasks', { status: 'todo,doing' }).then((tasks) => {
      for (const t of tasks) taskSel.append(h('option', { value: t.id }, t.title));
    }).catch(() => {});

    const submit = async () => {
      await api.post(`/api/activity/${gap.id}/resolve`, {
        app: label.value.trim() || '오프라인 작업',
        category_id: Number(cat.value),
        task_id: taskSel.value || null,
      });
      close();
      toast('시간을 채워 넣었습니다', 'ok');
      onChange?.();
    };
    label.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    return {
      title: `${hhmm(gap.started_at)} – ${hhmm(gap.ended_at)} (${dur(gap.seconds)})`,
      body: [
        h('label.field', '무엇을 하고 있었나요?', label),
        h('div.grid.cols-2',
          h('label.field', '카테고리', cat),
          h('label.field', '태스크에 연결', taskSel),
        ),
      ],
      footer: [
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: submit }, '저장'),
      ],
    };
  });
}
