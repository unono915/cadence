import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast } from '../lib/ui.js';
import { store, notify, refreshProjects } from '../lib/store.js';
import { LIMITS } from '../lib/limits.js';

/**
 * 흐름을 끊지 않는 빠른 입력.
 * mode 'task' — 제목 한 줄이면 충분하고, 나머지는 선택.
 * mode 'note' — 오늘 노트에 타임스탬프와 함께 덧붙인다.
 */
export function openQuickAdd(mode = 'task') {
  if (mode === 'note') return openQuickNote();
  return openQuickTask();
}

function openQuickTask() {
  openModal((close) => {
    const title = h('input', {
      type: 'text', placeholder: '무엇을 해야 하나요?', autofocus: true, maxlength: LIMITS.TASK_TITLE,
    });
    const project = h('select',
      h('option', { value: '' }, '프로젝트 없음'),
      store.projects.map((p) => h('option', { value: p.id }, p.name)),
    );
    const estimate = h('input', { type: 'number', min: 5, step: 5, placeholder: '예상 시간(분)' });

    // 어느 것이 눌려 있는지를 **색으로만** 알리면, 화면 낭독기에서는 그냥 버튼 셋이
    // 나란히 있을 뿐이다. 눈으로 보면 멀쩡해서 놓치기 쉬운 종류다 — `aria-pressed` 를 함께 단다.
    const LEVELS = ['낮음', '보통', '높음'];
    let importance = 1;
    let urgency = 1;
    const impBtns = LEVELS.map((label, v) => h('button.btn.sm', {
      class: v === importance ? 'primary' : '',
      'aria-pressed': String(v === importance),
      onclick: () => { importance = v; sync(); },
    }, label));
    const urgBtns = LEVELS.map((label, v) => h('button.btn.sm', {
      class: v === urgency ? 'primary' : '',
      'aria-pressed': String(v === urgency),
      onclick: () => { urgency = v; sync(); },
    }, label));
    const sync = () => {
      for (const [i, b] of impBtns.entries()) {
        b.className = `btn sm${i === importance ? ' primary' : ''}`;
        b.setAttribute('aria-pressed', String(i === importance));
      }
      for (const [i, b] of urgBtns.entries()) {
        b.className = `btn sm${i === urgency ? ' primary' : ''}`;
        b.setAttribute('aria-pressed', String(i === urgency));
      }
    };

    let startNow = false;
    const startBtn = h('button.btn.sm', {
      'aria-pressed': 'false',
      onclick: () => {
        startNow = !startNow;
        startBtn.className = `btn sm${startNow ? ' primary' : ''}`;
        startBtn.setAttribute('aria-pressed', String(startNow));
      },
      title: '만들자마자 집중 세션을 시작합니다',
    }, '▶ 바로 집중 시작');

    const submit = async () => {
      const value = title.value.trim();
      if (!value) { title.focus(); return; }
      const task = await api.post('/api/tasks', {
        title: value,
        project_id: project.value || null,
        estimate_min: estimate.value || null,
        importance,
        urgency,
      });
      close();
      toast('태스크를 추가했습니다', 'ok');
      if (startNow) {
        const { startFocus } = await import('../app.js');
        await startFocus(task.id);
      }
      notify('tasks');
    };

    title.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submit(); }
    });

    return {
      title: '빠른 추가',
      body: [
        h('label.field', '할 일', title),
        h('div.grid.cols-2',
          h('label.field', '프로젝트', project),
          h('label.field', '예상 시간 (분)', estimate),
        ),
        h('div.grid.cols-2',
          h('label.field', '중요도', h('div.row', { role: 'group', 'aria-label': '중요도' }, impBtns)),
          h('label.field', '긴급도', h('div.row', { role: 'group', 'aria-label': '긴급도' }, urgBtns)),
        ),
        h('div.row', startBtn),
      ],
      footer: [
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: submit }, '추가 (Enter)'),
      ],
    };
  });
}

function openQuickNote() {
  openModal((close) => {
    const text = h('textarea', {
      placeholder: '떠오른 생각, 결정, 남길 말…', autofocus: true, maxlength: LIMITS.NOTE_LINE,
    });
    const submit = async () => {
      const value = text.value.trim();
      if (!value) return;
      await api.post('/api/notes/append', { day: store.day, text: value });
      close();
      toast('메모를 남겼습니다', 'ok');
      notify('notes');
    };
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
    });
    return {
      title: '빠른 메모',
      body: [text, h('div.muted', { style: { fontSize: '12px' } }, 'Ctrl+Enter 로 저장 · 오늘 노트 맨 아래에 시각과 함께 붙습니다')],
      footer: [
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: submit }, '저장'),
      ],
    };
  });
}

const PROJECT_COLORS = ['#5b8def', '#4f9d69', '#e0a458', '#d9534f', '#8a6fd1', '#3fa9a0'];

/** 새 프로젝트. */
export function openNewProject(onDone) {
  return openProjectForm(null, onDone);
}

/** 기존 프로젝트 수정 (이름·색상·주간 목표·보관). */
export function openProjectEdit(project, onDone) {
  return openProjectForm(project, onDone);
}

function openProjectForm(project, onDone) {
  const editing = Boolean(project);

  openModal((close) => {
    const name = h('input', {
      type: 'text', placeholder: '프로젝트 이름', autofocus: true, maxlength: LIMITS.PROJECT_NAME,
    });
    if (editing) name.value = project.name;

    const target = h('input', {
      type: 'number', min: 15, step: 30, placeholder: '예: 600 (주 10시간)',
      value: editing && project.weekly_target_min ? project.weekly_target_min : '',
    });

    let picked = editing ? project.color : PROJECT_COLORS[0];
    const swatches = PROJECT_COLORS.map((c) => h('button.btn.sm', {
      style: { background: c, width: '28px', height: '24px', borderColor: c },
      onclick: () => { picked = c; sync(); },
      title: c,
    }, ''));
    const sync = () => swatches.forEach((b, i) => {
      b.style.outline = PROJECT_COLORS[i] === picked ? '2px solid var(--text)' : 'none';
      b.style.outlineOffset = '1px';
    });
    sync();

    const submit = async () => {
      const value = name.value.trim();
      if (!value) { name.focus(); return; }
      const payload = {
        name: value,
        color: picked,
        weekly_target_min: target.value ? Number(target.value) : null,
      };
      if (editing) await api.patch(`/api/projects/${project.id}`, payload);
      else await api.post('/api/projects', payload);
      await refreshProjects();
      close();
      toast(editing ? '프로젝트를 수정했습니다' : '프로젝트를 만들었습니다', 'ok');
      onDone?.();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const archive = async () => {
      await api.patch(`/api/projects/${project.id}`, { archived: !project.archived });
      await refreshProjects();
      close();
      toast(project.archived ? '보관을 해제했습니다' : '보관했습니다', 'ok');
      onDone?.();
    };

    return {
      title: editing ? '프로젝트' : '새 프로젝트',
      body: [
        h('label.field', '이름', name),
        h('label.field', '색상', h('div.row.wrap', swatches)),
        h('label.field', '주간 목표 시간 (분)', target,
          h('span', { style: { fontSize: '11px' } },
            '이 프로젝트에 매주 얼마를 쓸 작정인지. 리포트에서 실적과 나란히 보여 줍니다. 비워 두면 목표 없이 집계만 합니다.'),
        ),
      ],
      footer: [
        editing ? h('button.btn', { onclick: archive }, project.archived ? '보관 해제' : '보관') : null,
        h('div.spacer'),
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: submit }, editing ? '저장' : '만들기'),
      ],
    };
  });
}
