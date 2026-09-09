import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast } from '../lib/ui.js';
import { dur, pct, relativeDay, dayLabel, shiftDay } from '../lib/format.js';
import { store, notify, loadBase } from '../lib/store.js';
import { taskItem } from './task-item.js';
import { planFeasibility, nextMove } from '../lib/insights.js';
import { LIMITS } from '../lib/limits.js';

/**
 * "오늘 하기로 한 일".
 *
 * 할 일 목록 전체가 아니라 **오늘 실제로 끝낼 작정인 것**만 골라 두는 자리다.
 * 목록이 길어질수록 하루가 흐릿해지므로 3개를 권장선으로 두고, 넘기면 조용히 경고한다.
 */
const RECOMMENDED = 3;

/**
 * "남은 계획이 오늘 안에 들어가는가" 한 줄.
 *
 * 계획 옆에 붙여야 뜻이 있다. 하루가 끝난 뒤 "3개 중 1개 완료" 를 보는 것은 이미 늦고,
 * 지금 넘칠 것을 알아야 하나를 내일로 넘기는 선택을 할 수 있다.
 * 오늘이 아닌 날에는 예측할 것이 없으므로 그리지 않는다.
 */
function feasibilityLine(report) {
  if (report.day !== store.today) return null;
  const fit = planFeasibility(report);
  if (!fit) return null;

  const color = fit.verdict === 'over' ? 'var(--warn)' : fit.verdict === 'tight' ? 'var(--muted)' : 'var(--good)';
  const head = fit.verdict === 'over'
    ? `오늘 여력보다 ${dur(fit.over_sec)} 많습니다`
    : fit.verdict === 'tight' ? '오늘 여력에 빠듯합니다' : '오늘 여력 안에 들어갑니다';

  const detail = fit.biased
    ? `남은 ${fit.tasks}건 예상 ${dur(fit.estimate_sec)} → 당신의 추정 편향(${fit.ratio}배)을 반영하면 ${dur(fit.honest_sec)} · 평소 기준 남은 여력 ${dur(fit.capacity_sec)}`
    : `남은 ${fit.tasks}건 ${dur(fit.honest_sec)} · 평소 기준 남은 여력 ${dur(fit.capacity_sec)}`;

  return h('div', { style: { marginTop: '6px', fontSize: '12px' } },
    h('span', { style: { color, fontWeight: 600 } }, head),
    h('span.muted', { style: { display: 'block', fontSize: '11px', marginTop: '2px' } }, detail),
  );
}

/**
 * "지금 이걸 시작하세요" 한 줄.
 *
 * 계획을 세워 둬도 아침에 화면을 열면 "그래서 뭐부터?" 에서 한 번 더 멈춘다.
 * 이 도구는 그 답에 필요한 것을 이미 알고 있다 — 무엇이 남았고, 지금이 이 사람의
 * 몰입이 잘 되는 시간대인지. 고르는 일까지 대신 해 주고, 그 자리에서 시작하게 한다.
 */
function nextMoveLine(report, rhythm, onChange) {
  if (report.day !== store.today) return null;
  const move = nextMove({ report, rhythm });
  if (!move) return null;

  return h('div', {
    style: {
      marginTop: '10px', padding: '9px 11px', borderRadius: 'var(--radius-sm)',
      background: 'color-mix(in srgb, var(--accent) 10%, transparent)',
      border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)',
    },
  },
    h('div.row.wrap', { style: { justifyContent: 'space-between', gap: '8px' } },
      h('div', { style: { minWidth: '150px', flex: 1 } },
        h('div', { style: { fontSize: '13px', fontWeight: 600 } },
          '지금 시작할 일: ', move.task.title),
        h('div.muted', { style: { fontSize: '11px', marginTop: '2px' } }, move.reason),
      ),
      h('button.btn.sm.primary', {
        onclick: async () => {
          const { startFocus } = await import('../app.js');
          await startFocus(move.task.id);
          onChange?.();
        },
        title: `"${move.task.title}" 로 집중 세션을 시작합니다`,
      }, '▶ 시작'),
    ),
  );
}

export function planCard(report, plannedTasks, { onChange, rhythm = null } = {}) {
  const day = report.day;
  const estimateMin = report.tasks.planned_min;
  const doneCount = report.tasks.planned_done;
  const total = plannedTasks.length;

  const actualSec = plannedTasks.reduce((s, t) => s + (t.actual_sec || 0), 0);
  const over = estimateMin > 0 && actualSec / 60 > estimateMin * 1.2;

  return h('div.card',
    h('h2',
      `${relativeDay(day, store.today)} 하기로 한 일`,
      h('div.row',
        total ? h('span.sub', `${doneCount}/${total} 완료`) : null,
        h('button.btn.sm', { onclick: () => openPlanPicker(day, onChange) }, total ? '고치기' : '＋ 계획 세우기'),
      ),
    ),

    total === 0
      ? h('div.empty',
          h('div', '오늘 끝낼 일 두세 가지를 먼저 정해 두면 하루가 흐트러질 때 돌아올 자리가 생깁니다.'),
          h('button.btn.primary', { style: { marginTop: '12px' }, onclick: () => openPlanPicker(day, onChange) },
            '오늘 할 일 고르기'),
        )
      : h('div',
          h('div', { style: { marginBottom: '10px' } },
            h('div', {
              style: {
                height: '6px', background: 'var(--panel-2)', borderRadius: '3px',
                overflow: 'hidden', marginBottom: '6px',
              },
            },
              h('i', {
                style: {
                  display: 'block', height: '100%',
                  width: `${pct(doneCount, total)}%`,
                  background: doneCount === total ? 'var(--good)' : 'var(--accent)',
                  borderRadius: '3px', transition: 'width .3s',
                },
              }),
            ),
            h('div.row', { style: { fontSize: '12px', color: 'var(--muted)' } },
              estimateMin ? h('span', `예상 ${estimateMin}분`) : null,
              // 오늘 들인 시간이 아니라 이 태스크들에 여태 들어간 총합이다.
              // 며칠에 걸쳐 끌고 온 일이면 오늘치보다 훨씬 크게 나오므로 말로 못박아 둔다.
              actualSec
                ? h('span', { title: '이 태스크들에 지금까지 들어간 총 시간 (오늘치가 아닙니다)' },
                    `· 누적 ${dur(actualSec)}`)
                : null,
              over ? h('span', { style: { color: 'var(--warn)' } }, '· 예상을 넘겼습니다') : null,
              total > RECOMMENDED
                ? h('span', { style: { color: 'var(--warn)' } }, `· ${total}개는 하루에 많습니다`)
                : null,
            ),
            feasibilityLine(report),
          ),
          h('div.task-list', plannedTasks.map((t) => taskItem(t, { onChange, hideProject: false }))),
          nextMoveLine(report, rhythm, onChange),
        ),
  );
}

/** 열려 있는 태스크 중에서 오늘 것을 고르는 모달. */
export function openPlanPicker(day, onChange) {
  openModal((close) => {
    const listEl = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
    const counter = h('div.muted', { style: { fontSize: '12px' } });
    let tasks = [];
    const chosen = new Set();

    function paint() {
      counter.textContent = `${chosen.size}개 선택${chosen.size > RECOMMENDED ? ` — ${RECOMMENDED}개 이하를 권합니다` : ''}`;
      counter.style.color = chosen.size > RECOMMENDED ? 'var(--warn)' : 'var(--muted)';
      listEl.replaceChildren(...tasks.map((t) => {
        const on = chosen.has(t.id);
        return h('button.btn', {
          class: on ? 'primary' : '',
          // 고른 것과 안 고른 것을 색과 기호로만 나누면 화면 낭독기에서는 구별되지 않는다.
          'aria-pressed': String(on),
          style: { justifyContent: 'flex-start', textAlign: 'left', width: '100%', whiteSpace: 'normal' },
          onclick: () => { on ? chosen.delete(t.id) : chosen.add(t.id); paint(); },
        },
          h('span', { style: { marginRight: '8px' } }, on ? '✓' : '○'),
          t.title,
          t.estimate_min ? h('span', { style: { opacity: 0.7, marginLeft: '6px' } }, `· ${t.estimate_min}분`) : null,
          t.project_name ? h('span', { style: { opacity: 0.6, marginLeft: '6px' } }, `· ${t.project_name}`) : null,
        );
      }));
      if (!tasks.length) {
        listEl.replaceChildren(h('div.empty', '아직 열려 있는 태스크가 없습니다 — 아래에 바로 적어 보세요'));
      }
    }

    /**
     * 여기서 바로 태스크를 만들 수 있게 한다.
     *
     * 처음 쓰는 사람에게는 태스크가 하나도 없다. 그런데 오늘 화면은 "오늘 끝낼 일 두세
     * 가지를 정하세요" 라고 권한 뒤 이 창을 여는데, 예전에는 "열려 있는 태스크가 없습니다"
     * 한 줄과 취소·저장 버튼뿐이었다 — **시키는 대로 했더니 막다른 길**이었다.
     * 태스크 화면으로 갔다가 다시 돌아와야 한다는 것을 알아낼 방법도 없었다.
     *
     * 처음이 아니어도 쓸모가 있다. "이것도 오늘 해야지" 가 떠오르는 자리가 바로 여기다.
     */
    const titleInput = h('input', {
      type: 'text', maxlength: LIMITS.TASK_TITLE,
      placeholder: '새 태스크 제목…',
      'aria-label': '새 태스크 제목',
      style: { flex: 1 },
    });
    let adding = false;
    const addTask = async () => {
      const title = titleInput.value.trim();
      if (!title || adding) return;
      adding = true;
      try {
        const made = await api.post('/api/tasks', { title });
        tasks.push(made);
        chosen.add(made.id);
        titleInput.value = '';
        paint();
        titleInput.focus();
      } catch {
        // 메시지는 api 계층이 이미 띄웠다. 적어 둔 제목은 그대로 남겨 다시 누를 수 있게 한다.
      } finally {
        adding = false;
      }
    };
    titleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); addTask(); }
    });

    (async () => {
      const [open, already] = await Promise.all([
        api.get('/api/tasks', { status: 'todo,doing' }),
        api.get('/api/tasks', { status: 'todo,doing,done', planned_for: day }),
      ]);
      // 이미 오늘로 잡혀 있는 것(완료 포함)도 목록에 남겨서 해제할 수 있게 한다.
      const byId = new Map(open.map((t) => [t.id, t]));
      for (const t of already) byId.set(t.id, t);
      tasks = [...byId.values()];
      for (const t of already) chosen.add(t.id);
      paint();
    })();

    const save = async () => {
      const previous = tasks.filter((t) => t.planned_for === day).map((t) => t.id);
      const toAdd = [...chosen].filter((id) => !previous.includes(id));
      const toRemove = previous.filter((id) => !chosen.has(id));
      await Promise.all([
        ...toAdd.map((id) => api.patch(`/api/tasks/${id}`, { planned_for: day })),
        ...toRemove.map((id) => api.patch(`/api/tasks/${id}`, { planned_for: null })),
      ]);
      close();
      toast(`${chosen.size}개를 ${relativeDay(day, store.today)} 계획으로 잡았습니다`, 'ok');
      onChange?.();
      notify('tasks');
    };

    return {
      title: `${dayLabel(day)} 계획`,
      body: [
        h('div.hint',
          h('span.icon', 'i'),
          h('span', '오늘 끝낼 작정인 것만 고르세요. 하고 싶은 것 전부가 아니라, 하루가 흐트러졌을 때 돌아올 기준선입니다.'),
        ),
        counter,
        listEl,
        h('div.row', { style: { gap: '6px', marginTop: '2px' } },
          titleInput,
          h('button.btn', { onclick: addTask, title: '만들면서 오늘 계획에 함께 넣습니다' }, '＋ 추가'),
        ),
      ],
      footer: [
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: save }, '저장'),
      ],
    };
  });
}

/** 회고 한 줄에 붙는 머리말. 입력칸의 상한을 여기에 맞춰 깎는다. */
const REVIEW_PREFIX = '회고 — ';

/**
 * 하루 마무리 회고.
 * 지표를 다시 보여주는 것이 목적이 아니라, 계획과 실제의 차이를 한 번 마주 보고
 * 내일로 넘길 것을 정하게 하는 것이 목적이다.
 */
export function openDayReview(report, { onChange } = {}) {
  openModal((close) => {
    const planned = report.tasks.planned_tasks || [];
    const undone = planned.filter((t) => t.status !== 'done');
    const note = h('textarea', {
      placeholder: '오늘 잘 된 것 하나, 막힌 것 하나, 내일 먼저 할 것 하나.',
      style: { minHeight: '110px' },
      // 회고는 노트에 접두어를 달고 한 줄로 붙는다. 그 접두어까지가 한 줄 상한 안이므로
      // 여기서 그만큼 빼 둔다 — 안 그러면 상한 근처에서만 저장이 거절된다.
      maxlength: LIMITS.NOTE_LINE - REVIEW_PREFIX.length,
    });

    const carryOver = h('input', { type: 'checkbox' });
    carryOver.checked = undone.length > 0;

    const line = (label, value, tone) => h('div.row', { style: { justifyContent: 'space-between' } },
      h('span.muted', label),
      h('span', { style: tone ? { color: tone } : null }, value),
    );

    const submit = async () => {
      const tomorrow = shiftDay(report.day, 1);
      if (carryOver.checked && undone.length) {
        await Promise.all(undone.map((t) => api.patch(`/api/tasks/${t.id}`, { planned_for: tomorrow })));
      }
      if (note.value.trim()) {
        await api.post('/api/notes/append', { day: report.day, text: REVIEW_PREFIX + note.value.trim() });
      }
      // 마무리한 날을 기록해 두면 그날은 다시 알리지 않는다.
      await api.patch('/api/settings', { last_day_review: report.day });
      await loadBase();
      close();
      toast('하루를 마무리했습니다', 'ok');
      onChange?.();
    };

    return {
      title: `${dayLabel(report.day)} 마무리`,
      body: [
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px', fontSize: '13px' } },
          // 기록이 얕은 날의 0 점은 "오늘 형편없었다"가 아니라 "잴 것이 없었다"이다.
          // 마무리 화면 첫 줄에 0 을 띄우면 사람은 앞의 뜻으로 읽는다.
          line('Cadence 점수',
            report.score.insufficient ? '— (기록이 적어 점수를 매기지 않았습니다)' : `${report.score.total} / 100`),
          line('몰입 시간', dur(report.kinds.deep || 0)),
          line('몰입 블록', `${report.deep_blocks.length}개 · 최장 ${dur(report.longest_block_sec)}`),
          line('집중 세션', `${report.focus.completed}/${report.focus.started} 완주`),
          line('계획 이행', planned.length ? `${report.tasks.planned_done}/${planned.length}` : '계획 없음',
            planned.length && report.tasks.planned_done < planned.length ? 'var(--warn)' : null),
        ),
        undone.length
          ? h('div',
              h('div.section-title', { style: { marginTop: '6px' } }, '남은 계획'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', fontSize: '13px' } },
                undone.map((t) => h('div.muted', `• ${t.title}`)),
              ),
              h('label.row', { style: { marginTop: '8px', fontSize: '13px', cursor: 'pointer' } },
                carryOver, h('span', '내일 계획으로 넘기기'),
              ),
            )
          : null,
        h('label.field', '회고 한 줄', note),
      ],
      footer: [
        h('button.btn', { onclick: close }, '나중에'),
        h('button.btn.primary', { onclick: submit }, '마무리'),
      ],
    };
  });
}

