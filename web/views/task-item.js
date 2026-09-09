import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { toast, confirmDialog, openModal } from '../lib/ui.js';
import { dur, dueInfo, isoDay } from '../lib/format.js';
import { store, notify } from '../lib/store.js';
import { LIMITS } from '../lib/limits.js';

const IMPORTANCE = ['낮음', '보통', '높음'];

/** 태스크 한 줄. onChange 는 목록을 다시 그리기 위한 콜백. */
export function taskItem(task, { onChange, compact = false, hideProject = false } = {}) {
  const done = task.status === 'done';
  const due = dueInfo(task.due_at);

  const toggle = async () => {
    await api.patch(`/api/tasks/${task.id}`, { status: done ? 'todo' : 'done' });
    toast(done ? '다시 열었습니다' : '완료했습니다', 'ok');
    onChange?.();
  };

  const title = h('span.title', { onclick: () => openTaskDetail(task, onChange) }, task.title);

  const meta = h('div.meta',
    task.project_name && !hideProject
      ? h('span.tag', h('span.swatch', { style: { background: task.project_color } }), task.project_name)
      : null,
    task.estimate_min ? h('span', `예상 ${task.estimate_min}분`) : null,
    task.actual_sec > 0 ? h('span', `· 실제 ${dur(task.actual_sec)}`) : null,
    task.accuracy && task.accuracy > 1.3
      ? h('span', { style: { color: 'var(--warn)' } }, `· ${task.accuracy}× 초과`)
      : null,
    due ? h('span', { style: { color: due.overdue ? 'var(--bad)' : due.soon ? 'var(--warn)' : null } }, `· ${due.text}`) : null,
    task.quadrant === 1 && !done ? h('span.tag', { style: { color: 'var(--bad)' } }, '중요·긴급') : null,
  );

  const plannedToday = task.planned_for === store.day;

  const actions = h('div.actions',
    !done
      ? h('button.btn.ghost.sm', {
          title: plannedToday ? '오늘 계획에서 빼기' : '오늘 계획에 넣기',
          'aria-label': plannedToday ? `${task.title}: 오늘 계획에서 빼기` : `${task.title}: 오늘 계획에 넣기`,
          style: plannedToday ? { color: 'var(--accent)' } : null,
          onclick: async () => {
            await api.patch(`/api/tasks/${task.id}`, { planned_for: plannedToday ? null : store.day });
            toast(plannedToday ? '오늘 계획에서 뺐습니다' : '오늘 계획에 넣었습니다', 'ok');
            onChange?.();
          },
        }, plannedToday ? '★' : '☆')
      : null,
    !done && store.session?.task_id !== task.id
      ? h('button.btn.ghost.sm', {
          title: '이 태스크로 집중 시작 (25분)',
          'aria-label': `${task.title}: 집중 세션 시작`,
          onclick: async () => {
            const { startFocus } = await import('../app.js');
            await startFocus(task.id);
            onChange?.();
          },
        }, '▶')
      : null,
    h('button.btn.ghost.sm', {
      title: '상세', 'aria-label': `${task.title}: 상세 보기`,
      onclick: () => openTaskDetail(task, onChange),
    }, '⋯'),
  );

  return h(`div.task${done ? '.done' : ''}${task.status === 'doing' ? '.doing' : ''}`,
    { dataset: { id: String(task.id) } },
    h('button.check', {
      class: done ? 'on' : '', onclick: toggle,
      title: done ? '완료 취소' : '완료',
      'aria-label': `${task.title}: ${done ? '완료 취소' : '완료로 표시'}`,
      'aria-pressed': done ? 'true' : 'false',
    },
      done ? h('span', { style: { fontSize: '11px', color: '#fff', lineHeight: 1 } }, '✓') : null),
    h('div.body', title, compact && !meta.childNodes.length ? null : meta),
    actions,
  );
}

/** 태스크 상세/편집 모달. */
export function openTaskDetail(task, onChange) {
  openModal((close) => {
    const title = h('input', { type: 'text', value: task.title, maxlength: LIMITS.TASK_TITLE });
    const notes = h('textarea', { placeholder: '메모, 진행 상황, 다음 단계…', maxlength: LIMITS.TASK_NOTES });
    notes.value = task.notes || '';
    const project = h('select',
      h('option', { value: '' }, '프로젝트 없음'),
      store.projects.map((p) => h('option', { value: p.id, selected: p.id === task.project_id }, p.name)),
    );
    const estimate = h('input', { type: 'number', min: 5, step: 5, value: task.estimate_min ?? '' });
    const status = h('select',
      ['todo', 'doing', 'done', 'archived'].map((s) => h('option', {
        value: s, selected: s === task.status,
      }, { todo: '할 일', doing: '진행 중', done: '완료', archived: '보관' }[s])),
    );
    const due = h('input', {
      type: 'date',
      value: task.due_at ? isoDay(task.due_at) : '',
    });

    let importance = task.importance;
    let urgency = task.urgency;
    // 눌린 상태를 색으로만 알리면 화면 낭독기에서는 버튼 셋이 나란히 있을 뿐이다.
    const mkToggle = (getter, setter, label) => {
      const btns = [0, 1, 2].map((v) => h('button.btn.sm', {
        onclick: () => { setter(v); sync(); },
      }, IMPORTANCE[v]));
      const sync = () => {
        for (const [i, b] of btns.entries()) {
          b.className = `btn sm${i === getter() ? ' primary' : ''}`;
          b.setAttribute('aria-pressed', String(i === getter()));
        }
      };
      sync();
      return h('div.row', { role: 'group', 'aria-label': label }, btns);
    };
    const impRow = mkToggle(() => importance, (v) => { importance = v; }, '중요도');
    const urgRow = mkToggle(() => urgency, (v) => { urgency = v; }, '긴급도');

    const save = async () => {
      await api.patch(`/api/tasks/${task.id}`, {
        title: title.value.trim() || task.title,
        notes: notes.value,
        project_id: project.value || null,
        estimate_min: estimate.value || null,
        status: status.value,
        importance,
        urgency,
        due_at: due.value ? new Date(`${due.value}T18:00:00`).getTime() : null,
      });
      close();
      toast('저장했습니다', 'ok');
      onChange?.();
      notify('tasks');
    };

    const remove = async () => {
      if (!(await confirmDialog(`"${task.title}" 태스크를 삭제할까요? 되돌릴 수 없습니다.`, {
        title: '태스크 삭제', danger: true, okLabel: '삭제',
      }))) return;
      await api.del(`/api/tasks/${task.id}`);
      close();
      toast('삭제했습니다', 'ok');
      onChange?.();
      notify('tasks');
    };

    const stats = h('dl.kv',
      h('dt', '집중 세션'), h('dd', dur(task.focus_sec)),
      h('dt', '자동 추적'), h('dd', dur(task.tracked_sec)),
      h('dt', '총 소요'), h('dd', dur(task.actual_sec)),
      task.estimate_min && task.actual_sec
        ? [h('dt', '추정 대비'), h('dd', `${task.accuracy}×`)]
        : null,
    );

    return {
      title: '태스크',
      body: [
        h('label.field', '제목', title),
        h('div.grid.cols-2',
          h('label.field', '프로젝트', project),
          h('label.field', '상태', status),
        ),
        h('div.grid.cols-2',
          h('label.field', '예상 시간 (분)', estimate),
          h('label.field', '마감일', due),
        ),
        h('div.grid.cols-2',
          h('label.field', '중요도', impRow),
          h('label.field', '긴급도', urgRow),
        ),
        h('label.field', '메모', notes),
        h('div', h('div.section-title', { style: { marginTop: '4px' } }, '기록'), stats),
      ],
      footer: [
        h('button.btn.danger', { onclick: remove }, '삭제'),
        h('div.spacer'),
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: save }, '저장'),
      ],
    };
  });
}
