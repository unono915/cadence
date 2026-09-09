import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { pillGroup, clickable } from '../lib/ui.js';
import { dur } from '../lib/format.js';
import { store, refreshProjects, remembered, remember } from '../lib/store.js';
import { taskItem } from './task-item.js';
import { openQuickAdd, openNewProject, openProjectEdit } from './quick-add.js';
import { makeSortable } from '../lib/sortable.js';
import { toast } from '../lib/ui.js';

const MODE_KEY = 'cadence.tasks.mode';

const QUADRANTS = [
  { id: 1, cls: 'q1', title: '중요 · 긴급', hint: '지금 처리' },
  { id: 2, cls: 'q2', title: '중요 · 여유', hint: '시간을 미리 확보' },
  { id: 3, cls: 'q3', title: '급하지만 덜 중요', hint: '줄이거나 넘기기' },
  { id: 4, cls: 'q4', title: '나머지', hint: '과감히 정리' },
];

export async function render(root) {
  const state = {
    mode: remembered(MODE_KEY, ['list', 'quadrant']),
    status: 'open',
    project: '',
    q: '',
  };

  async function load() {
    const statusParam = { open: 'todo,doing', done: 'done', all: 'todo,doing,done', archived: 'archived' }[state.status];
    const tasks = await api.get('/api/tasks', {
      status: statusParam,
      project_id: state.project || undefined,
      q: state.q || undefined,
    });
    draw(tasks);
  }

  function toolbar() {
    const search = h('input', {
      type: 'search', placeholder: '검색…', value: state.q,
      style: { maxWidth: '220px' },
    });
    let searchTimer;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.q = search.value.trim(); load(); }, 220);
    });

    // 첫 항목이 '모든 프로젝트' 라 눈으로는 뜻이 통하지만, 화면 낭독기는 그냥 '콤보 상자' 로 읽는다.
    const projectSel = h('select', { style: { maxWidth: '180px' }, 'aria-label': '프로젝트로 거르기' },
      h('option', { value: '' }, '모든 프로젝트'),
      store.projects.map((p) => h('option', { value: p.id, selected: String(p.id) === String(state.project) }, p.name)),
    );
    projectSel.addEventListener('change', () => { state.project = projectSel.value; load(); });

    return h('div.row.wrap', { style: { marginBottom: '14px' } },
      pillGroup(
        [
          { value: 'list', label: '목록' },
          { value: 'quadrant', label: '우선순위 매트릭스', title: '중요도 × 긴급도' },
        ],
        state.mode,
        (v) => { state.mode = v; remember(MODE_KEY, v); load(); },
        { label: '보기 방식' },
      ),
      pillGroup(
        [
          { value: 'open', label: '진행' },
          { value: 'done', label: '완료' },
          { value: 'all', label: '전체' },
          { value: 'archived', label: '보관' },
        ],
        state.status,
        (v) => { state.status = v; load(); },
        { label: '상태로 거르기' },
      ),
      projectSel,
      search,
      h('div.spacer'),
      h('button.btn', { onclick: () => openNewProject(load) }, '＋ 프로젝트'),
      h('button.btn.primary', { onclick: () => openQuickAdd('task') }, '＋ 태스크 (N)'),
    );
  }

  function projectSummary() {
    if (!store.projects.length) return null;
    const active = String(state.project);
    return h('div.card', { style: { marginBottom: '14px' } },
      h('h2', '프로젝트', h('span.sub', '이름을 눌러 거르고, ⋯ 로 주간 목표를 정합니다')),
      h('div.row.wrap',
        store.projects.map((p) => h('span.tag', {
          style: {
            padding: '4px 4px 4px 10px', gap: '7px',
            borderColor: active === String(p.id) ? p.color : null,
          },
          title: `완료 ${p.done_tasks} / 열림 ${p.open_tasks}${p.weekly_target_min ? ` · 주간 목표 ${p.weekly_target_min}분` : ''}`,
        },
          h('span.swatch', { style: { background: p.color } }),
          h('span', clickable({
            style: { cursor: 'pointer' },
          }, () => { state.project = active === String(p.id) ? '' : String(p.id); load(); },
          `${p.name} 프로젝트로 거르기`), p.name),
          h('span.muted', `${p.open_tasks}`),
          p.weekly_target_min
            ? h('span.muted', { style: { fontSize: '10px' } }, `${Math.round(p.weekly_target_min / 60)}h/주`)
            : null,
          h('button.btn.ghost.sm', {
            style: { padding: '0 5px', lineHeight: 1.4 },
            onclick: () => openProjectEdit(p, load),
            title: '프로젝트 설정',
          }, '⋯'),
        )),
        state.project
          ? h('button.btn.ghost.sm', { onclick: () => { state.project = ''; load(); } }, '필터 해제')
          : null,
      ),
    );
  }

  function draw(tasks) {
    const body = state.mode === 'quadrant' ? quadrantView(tasks) : listView(tasks);
    mount(root, toolbar(), projectSummary(), body);
  }

  function listView(tasks) {
    if (!tasks.length) return h('div.card', h('div.empty', '조건에 맞는 태스크가 없습니다'));

    // 프로젝트별로 묶어서 보여준다 — 목록이 길어질수록 이쪽이 읽기 쉽다.
    const groups = new Map();
    for (const t of tasks) {
      const key = t.project_id ?? 0;
      if (!groups.has(key)) groups.set(key, { name: t.project_name || '프로젝트 없음', color: t.project_color, items: [] });
      groups.get(key).items.push(t);
    }

    return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '18px' } },
      [...groups.values()].map((g) => h('div',
        h('div.section-title', {
          style: {
            display: 'flex', alignItems: 'center', gap: '7px', margin: '0 0 8px',
            textTransform: 'none', letterSpacing: '0', fontSize: '13px',
          },
        },
          g.color ? h('span.swatch', { style: { background: g.color, width: '8px', height: '8px', borderRadius: '50%' } }) : null,
          g.name,
          h('span', { style: { color: 'var(--muted)', fontWeight: 400 } }, `${g.items.length}`),
          h('span.spacer'),
          h('span', { style: { color: 'var(--muted)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 } },
            `예상 ${g.items.reduce((s, t) => s + (t.estimate_min || 0), 0)}분 · 실제 ${dur(g.items.reduce((s, t) => s + t.actual_sec, 0))}`),
        ),
        sortableList(g.items),
      )),
    );
  }

  /**
   * 드래그(또는 Alt+↑/↓)로 순서를 바꿀 수 있는 목록.
   * 순서는 서버의 sort_order 에 저장되어 다음에 열 때도 유지된다.
   */
  function sortableList(items) {
    const list = h('div.task-list', items.map((t) => taskItem(t, { onChange: load, hideProject: true })));

    // **마지막으로 저장한 순서**를 따로 들고 있는다.
    //
    // 처음 그린 순서와 비교하면, A→B 로 옮겼다가 다시 B→A 로 되돌렸을 때
    // "처음과 같으니 저장할 것 없음" 으로 판단해 건너뛴다 — 서버에는 A→B 가 남는다.
    // 화면과 저장된 값이 조용히 갈라지고, 다음에 열면 되돌린 것이 사라져 있다.
    let saved = items.map((t) => t.id).join(',');

    // DOM 에 붙은 뒤 초기화해야 draggable 속성이 제대로 먹는다.
    queueMicrotask(() => makeSortable(list, {
      onReorder: async (ids) => {
        const next = ids.join(',');
        if (next === saved) return;
        try {
          await api.post('/api/tasks/reorder', { ids });
          saved = next;
          toast('순서를 저장했습니다', 'ok', 1600);
        } catch {
          // 저장이 안 됐는데 화면만 새 순서로 남으면, 다음에 열 때 이유 없이 되돌아간 것처럼 보인다.
          // 메시지는 api 계층이 이미 띄웠으니 화면만 서버 상태로 되돌린다.
          load();
        }
      },
    }));
    return list;
  }

  function quadrantView(tasks) {
    return h('div.quadrants',
      QUADRANTS.map((q) => {
        const items = tasks.filter((t) => t.quadrant === q.id);
        return h(`div.quadrant.${q.cls}`,
          h('h3', q.title, h('span.n', `${items.length}`), h('span.spacer'), h('span.n', q.hint)),
          items.length
            ? h('div.task-list', items.map((t) => taskItem(t, { onChange: load, compact: true })))
            : h('div.empty', { style: { padding: '14px' } }, '비어 있음'),
        );
      }),
    );
  }

  await refreshProjects().catch(() => {});
  await load();
  return { refresh: load };
}
