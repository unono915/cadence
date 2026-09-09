import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { dur, hhmm, relativeDay, shiftDay } from '../lib/format.js';
import { store, loadBase, refreshTracker } from '../lib/store.js';
import { openModal, toast, confirmDialog, clickable } from '../lib/ui.js';
import { scoreRing, donut, legend, barList, timelineStrip, hourHeatmap } from '../lib/charts.js';
import { dayInsights } from '../lib/insights.js';
import { taskItem } from './task-item.js';
import { openQuickAdd } from './quick-add.js';
import { planCard, openDayReview } from './daily-plan.js';
import { gapsCard } from './gaps.js';
import { LIMITS } from '../lib/limits.js';


/**
 * 읽을거리가 시킨 일을 그 자리에서 하게 해 주는 버튼.
 *
 * "지금 25분 세션을 시작하세요" 라고 써 놓고 시작할 방법을 주지 않으면, 읽는 사람은
 * 화면을 옮겨 다니다 그만둔다. 조언과 실행 사이의 거리가 멀수록 조언은 무시된다.
 */
function insightAction(insight) {
  const go = {
    // app.js 는 이 화면을 동적으로 불러온다. 여기서 정적으로 되받으면 순환이 된다.
    focus: ['집중 시작', async () => { (await import('../app.js')).startFocus(); }],
    // 타임라인으로 보내는 데서 그치면, 거기서 다시 카드를 찾아 "제목별로 나누기" 를
    // 눌러야 정리가 시작된다 — 이 앱에서 가장 값진 동작인데 가는 길이 가장 길었다.
    // `classify=1` 을 붙여 도착하자마자 가장 큰 미분류 앱의 정리창을 연다.
    classify: ['분류하러 가기', () => { location.hash = '#/timeline?classify=1'; }],
    tasks: ['태스크 보기', () => { location.hash = '#/tasks'; }],
    settings: ['목표 바꾸기', () => { location.hash = '#/settings'; }],
  }[insight.action];
  if (!go) return null;

  const [label, run] = go;
  return h('button.btn.sm', {
    style: { marginLeft: '8px', verticalAlign: 'middle' },
    onclick: run,
  }, label);
}

/**
 * 추적이 멈춰 있으면 크게 알린다.
 *
 * 자동 추적이 꺼진 채로 하루가 지나면 그날은 통째로 빈다 — 그런데 화면은 "몰입 0분" 이라고
 * 말할 뿐, 그것이 "일을 안 했다" 인지 "기록이 안 됐다" 인지 구별해 주지 않는다.
 * 왼쪽 아래 작은 칩만으로는 아무도 눈치채지 못하므로, 오늘 화면 맨 위에 세워 둔다.
 * 오늘이 아닌 날을 볼 때는 지금 상태가 그날과 무관하므로 띄우지 않는다.
 */
function trackerWarning(onChange) {
  const t = store.tracker || {};
  if (store.day !== store.today) return null;
  if (!t.supported) return null;
  if (t.running && !t.lastError) return null;

  const reason = t.running
    ? t.lastError
    : t.paused
      ? '자동 추적이 일시정지되어 있습니다. 멈춰 있는 동안의 시간은 어디에도 기록되지 않습니다.'
      : '자동 추적이 꺼져 있습니다. 지금 이 시간은 기록되지 않고 있습니다.';

  return h('div.card', {
    style: { borderColor: 'color-mix(in srgb, var(--warn) 45%, transparent)' },
  },
    h('h2', t.running ? '추적기에 문제가 있습니다' : '기록이 멈춰 있습니다'),
    h('div', { style: { fontSize: '13px', marginBottom: '10px' } }, reason),
    h('div.row.wrap',
      t.running
        ? null
        : h('button.btn.primary', {
            onclick: async () => {
              await api.post('/api/tracker/start');
              await refreshTracker();
              toast('자동 추적을 시작했습니다', 'ok');
              onChange?.();
            },
          }, '지금 시작'),
      h('button.btn.ghost', { onclick: () => { location.hash = '#/settings'; } }, '설정에서 진단'),
    ),
  );
}

const PART_LABELS = {
  deep: '몰입',
  continuity: '연속성',
  fragmentation: '집중 유지',
  distraction: '방해 없음',
  sessions: '세션 이행',
};
const PART_MAX = { deep: 40, continuity: 20, fragmentation: 15, distraction: 15, sessions: 10 };

export async function render(root) {
  let noteTimer = null;

  async function load() {
    const day = store.day;
    const [report, segments, tasks, planned, sessions, note, gaps, gapLabels, lastWeek, rhythm] = await Promise.all([
      api.get('/api/report/day', { day }),
      api.get('/api/activity', { day, min_sec: 20 }),
      api.get('/api/tasks', { status: 'todo,doing' }),
      api.get('/api/tasks', { status: 'todo,doing,done', planned_for: day }),
      api.get('/api/sessions', { day }),
      api.get('/api/notes', { day }),
      api.get('/api/activity/gaps', { day, min_sec: 900 }),
      api.get('/api/activity/gap-labels'),
      api.get('/api/report/week', { day: shiftDay(day, -7) }),
      api.get('/api/report/rhythm', { weeks: 8, day }),
    ]);
    if (store.day !== day) return; // 그리는 사이에 날짜가 바뀌면 버린다
    draw({ report, segments, tasks, planned, sessions, note, gaps, gapLabels, lastWeek, rhythm });
  }

  function draw({ report, segments, tasks, planned, sessions, note, gaps, gapLabels, lastWeek, rhythm }) {
    const active = report.active_sec;
    const insights = dayInsights(report, { rhythm, isToday: store.day === store.today });
    // 설정에서 바꿀 수 있는 값이다. 문장에 숫자를 박아 두면 바꾼 사람에게만 화면이 거짓말한다.
    const focusMin = report.targets.focus_min;

    // --- 첫 실행 안내 ---
    // 아무것도 없는 화면은 "고장 난 건가?"로 읽힌다. 처음 세 걸음만 짚어 준다.
    //
    // 판단은 서버가 한다. 예전에는 여기서 "오늘이 비었는가" 로 봤는데, 그러면 몇 달 쓴
    // 사람이 하루 쉬고 온 날 아침에 첫 실행 안내가 떴다 — 도구가 자기를 잊은 것처럼 보인다.
    const brandNew = report.first_run;
    const welcome = brandNew
      ? h('div.card', { style: { borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' } },
          h('h2', 'Cadence 를 시작합니다'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '13px' } },
            h('div', '이 도구는 하루가 끝났을 때 ', h('b', '"시간이 어디로 갔는가"'), ' 에 답하도록 만들어졌습니다. 세 가지만 해 두면 나머지는 알아서 쌓입니다.'),
            h('ol', { style: { margin: 0, paddingLeft: '18px', display: 'flex', flexDirection: 'column', gap: '7px' } },
              h('li', h('b', '자동 추적이 켜져 있는지 확인하세요.'), ' 왼쪽 아래에 “추적 중”이라고 떠 있으면 됩니다. 지금부터 어떤 창에서 얼마나 머물렀는지가 기록됩니다.'),
              h('li', h('b', '오늘 끝낼 일 두세 가지를 정하세요.'), ' 할 일 전부가 아니라, 하루가 흐트러졌을 때 돌아올 기준선입니다.'),
              h('li', h('b', '집중 세션을 한 번 돌려 보세요.'), ` ${focusMin}분이 지나면 알림이 옵니다. 세션 중의 활동은 해당 태스크에 자동으로 붙습니다.`),
            ),
            h('div.muted', { style: { fontSize: '12px' } },
              '데이터는 이 PC 밖으로 나가지 않습니다. 분류가 어색하면 타임라인에서 기록을 눌러 바로잡을 수 있고, 그 판단은 규칙으로 기억됩니다.'),
            h('div.row.wrap', { style: { marginTop: '2px' } },
              h('button.btn.primary', { onclick: () => openQuickAdd('task') }, '첫 태스크 만들기'),
              h('button.btn', { onclick: async () => { const m = await import('../app.js'); await m.startFocus(); } },
                `${focusMin}분 집중 시작`),
              h('button.btn.ghost', { onclick: () => { location.hash = '#/settings'; } }, '설정 둘러보기'),
            ),
          ),
        )
      : null;

    // --- 주간 리뷰 안내 ---
    // 리뷰는 알려주지 않으면 하지 않게 된다. 지난주에 기록이 있는데 아직 돌아보지 않았다면
    // 이번 주가 흐르기 전에 한 번만 권한다. 리뷰를 마치면 다시 뜨지 않는다.
    const reviewedWeek = store.settings.last_weekly_review || '';
    const lastWeekMonday = lastWeek?.days?.[0];
    const needsReview = store.day === store.today
      && lastWeekMonday
      && reviewedWeek !== lastWeekMonday
      && lastWeek.totals.active_sec > 3600;

    const reviewNudge = needsReview
      ? h('div.card', { style: { borderColor: 'color-mix(in srgb, var(--accent) 40%, transparent)' } },
          h('div.row.wrap',
            h('span', { style: { flex: 1, minWidth: '240px' } },
              h('b', '지난주를 아직 돌아보지 않았습니다.'),
              ` ${lastWeek.days[0]} – ${lastWeek.days[6]} 동안 몰입 ${dur(lastWeek.totals.deep_sec)}. `,
              '무엇이 잘 됐고 무엇이 시간을 뺏었는지 2분이면 정리됩니다.'),
            h('button.btn.primary', {
              onclick: async () => {
                const { openWeeklyReview } = await import('./weekly-review.js');
                openWeeklyReview(lastWeek, { onDone: load, rhythm });
              },
            }, '주간 리뷰 열기'),
            h('button.btn.ghost', {
              onclick: async () => {
                await api.patch('/api/settings', { last_weekly_review: lastWeekMonday });
                await loadBase();
                load();
              },
            }, '건너뛰기'),
          ),
        )
      : null;

    // --- 점수 카드 ---
    const scoreCard = h('div.card',
      h('h2', 'Cadence 점수',
        h('div.row',
          h('span.sub', relativeDay(report.day, store.today)),
          h('button.btn.sm', {
            onclick: () => openDayReview(report, { onChange: load }),
            title: '계획과 실제를 마주 보고 내일로 넘길 것을 정합니다',
          }, '하루 마무리'),
        ),
      ),
      h('div.score-card',
        // 미분류가 절반을 넘는 날은 점수가 하루가 아니라 분류 상태를 재고 있다.
        // 숫자를 지우지는 않되, 그대로 믿지 않도록 흐리게 두고 이유를 붙인다.
        scoreRing(report.score.total, { muted: report.score.insufficient || report.score.unreliable }),
        h('div.score-meta',
          report.score.insufficient
            ? h('div.muted', { style: { fontSize: '12px' } }, '점수를 매길 만큼 기록이 쌓이지 않았습니다')
            : h('div.score-parts',
                Object.entries(report.score.parts)
                  // 세션을 쓰지 않은 날은 그 항목을 빼고 나머지를 100점으로 환산한다.
                  .filter(([, value]) => value !== null)
                  .map(([key, value]) => h('div.part',
                    h('span.muted', PART_LABELS[key]),
                    h('span.bar', h('i', { style: { width: `${(value / PART_MAX[key]) * 100}%` } })),
                    h('span.muted.mono', `${value}`),
                  )),
                report.score.session_scored
                  ? null
                  : h('div.muted', { style: { fontSize: '11px', marginTop: '2px' } },
                      '집중 세션을 쓰지 않은 날이라 나머지 항목을 100점으로 환산했습니다'),
                report.score.unreliable
                  ? h('div', { style: { fontSize: '11px', marginTop: '4px', color: 'var(--warn)' } },
                      `활동의 ${Math.round(report.score.unclassified_ratio * 100)}%가 미분류라 이 점수는 아직 하루를 설명하지 못합니다`)
                  : null,
              ),
        ),
      ),
    );

    // --- 핵심 지표 ---
    // 숫자 하나만으로는 좋은 하루인지 알 수 없다. 최근 기록된 날들의 중앙값과 나란히 둔다.
    const base = report.baseline;

    /** 기준선 대비 증감. higherIsBetter=false 면 줄어든 쪽이 좋은 것으로 색을 준다. */
    const delta = (todaySec, baseSec, { higherIsBetter = true, threshold = 300 } = {}) => {
      if (!base?.enough || baseSec === null || baseSec === undefined) return null;
      const diff = todaySec - baseSec;
      if (Math.abs(diff) < threshold) {
        return h('span.delta.muted', `평소와 비슷 (중앙값 ${dur(baseSec)})`);
      }
      const good = higherIsBetter ? diff > 0 : diff < 0;
      return h(`span.delta.${good ? 'up' : 'down'}`,
        `평소보다 ${diff > 0 ? '+' : '−'}${dur(Math.abs(diff))}`);
    };

    const metric = (label, value, sub) => h('div.card',
      h('div.stat',
        h('span.value', value),
        h('span.label', label),
        typeof sub === 'string' ? h('span.delta.muted', sub) : sub,
      ),
    );

    const metrics = h('div.grid.cols-4',
      metric('몰입 시간', dur(report.kinds.deep || 0),
        delta(report.kinds.deep || 0, base?.deep_sec) || `목표 ${report.targets.deep_min}분`),
      metric('몰입 블록', `${report.deep_blocks.length}개`,
        report.longest_block_sec
          ? `최장 ${dur(report.longest_block_sec)}`
          : `${report.targets.block_min}분 이상 연속 구간`),
      // 시간당 값은 **활동 시간**으로 나눈 것이다. 잠깐씩만 앉은 날에는 분모가 작아
      // 쉽게 커지므로, 무엇으로 나눈 값인지 옆에 적어 둔다 — 그래야 60회/h 를 보고
      // "내가 산만한가" 대신 "한 시간밖에 안 앉았구나" 를 먼저 떠올린다.
      metric('앱 전환', `${report.switches_per_hour}회/h`,
        active ? `총 ${report.switches}회 · 활동 ${dur(active)} 기준` : `총 ${report.switches}회`),
      metric('활동 시간', dur(active),
        delta(active, base?.active_sec)
          || (report.first_at ? `${hhmm(report.first_at)} – ${hhmm(report.last_at)}` : '기록 없음')),
    );

    // --- 시간 배분 ---
    const distribution = h('div.card',
      h('h2', '시간 배분'),
      h('div', { style: { display: 'flex', gap: '18px', alignItems: 'center', flexWrap: 'wrap' } },
        donut(report.by_category.map((c) => ({ name: c.name, color: c.color, seconds: c.seconds }))),
        h('div', { style: { flex: '1', minWidth: '180px' } },
          report.by_category.length
            ? legend(report.by_category, active)
            : h('div.empty', '분류된 활동이 없습니다'),
        ),
      ),
    );

    // --- 타임라인 ---
    const timeline = h('div.card',
      h('h2', '하루 타임라인', h('span.sub', '아래 초록 선 = 몰입 블록')),
      timelineStrip(segments, {
        blocks: report.deep_blocks,
        showNow: store.day === store.today,
      }),
      h('div', { style: { marginTop: '14px' } },
        h('h2', { style: { marginBottom: '6px' } }, '시간대별 밀도'),
        hourHeatmap(report.hourly),
      ),
    );

    // --- 인사이트 ---
    const insightCard = insights.length
      ? h('div.card',
          h('h2', '오늘의 읽을거리'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            insights.map((i) => h('div.hint', {
              style: i.kind === 'good'
                ? { background: 'color-mix(in srgb, var(--good) 12%, transparent)', borderColor: 'color-mix(in srgb, var(--good) 32%, transparent)' }
                : i.kind === 'warn'
                  ? { background: 'color-mix(in srgb, var(--warn) 11%, transparent)', borderColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' }
                  : null,
            },
              h('span.icon', i.kind === 'good' ? '✓' : i.kind === 'warn' ? '!' : 'i'),
              h('span', i.text, insightAction(i)),
            )),
          ),
        )
      : null;

    // --- 상위 앱 ---
    const apps = h('div.card',
      h('h2', '많이 쓴 앱'),
      report.top_apps.length
        ? barList(report.top_apps.map((a) => ({ name: a.app, seconds: a.seconds })), { total: active })
        : h('div.empty', '기록 없음'),
    );

    // --- 태스크 ---
    const plannedIds = new Set(planned.map((t) => t.id));
    const rest = tasks.filter((t) => !plannedIds.has(t.id));
    const doing = rest.filter((t) => t.status === 'doing');
    const todo = rest.filter((t) => t.status === 'todo').slice(0, 8);
    const taskCard = h('div.card',
      h('h2', '그 밖의 열린 일', h('div.row',
        h('span.sub', `${rest.length}개`),
        h('button.btn.sm', { onclick: () => openQuickAdd('task') }, '＋ 추가'),
      )),
      doing.length || todo.length
        ? h('div.task-list',
            doing.map((t) => taskItem(t, { onChange: load })),
            todo.map((t) => taskItem(t, { onChange: load })),
          )
        : h('div.empty', '남은 태스크가 없습니다'),
    );

    // --- 집중 세션 ---
    const focusCard = h('div.card',
      h('h2', '집중 세션',
        h('span.sub', `${report.focus.completed}/${report.focus.started} 완주 · ${dur(report.focus.total_sec)}`),
      ),
      sessions.length
        ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
            sessions.map((s) => h('div.row', clickable({
              style: { fontSize: '13px', cursor: 'pointer' },
              title: '눌러서 메모와 연결 태스크를 고칩니다',
            }, () => openSessionEditor(s, tasks, load), `${hhmm(s.started_at)} 세션 고치기`),
              h('span.mono.muted', hhmm(s.started_at)),
              h('span.nowrap', { style: { flex: 1 } },
                s.kind === 'break' ? '휴식' : (s.task_title || '집중'),
                s.note ? h('span.muted', { style: { marginLeft: '6px', fontSize: '11px' } }, `· ${s.note}`) : null),
              s.interruptions ? h('span.tag', `방해 ${s.interruptions}`) : null,
              h('span.mono.muted', dur(s.elapsed_sec)),
              h('span.tag', {
                style: s.status === 'done'
                  ? { color: 'var(--good)' }
                  : s.status === 'running' ? { color: 'var(--accent)' } : { color: 'var(--muted)' },
              }, { done: '완주', running: '진행 중', abandoned: '중단' }[s.status]),
            )),
          )
        : h('div.empty', '아직 세션이 없습니다'),
    );

    // --- 노트 ---
    const noteArea = h('textarea', {
      placeholder: '오늘의 메모 — 결정한 것, 막힌 것, 내일로 넘길 것…',
      style: { minHeight: '150px' },
    });
    noteArea.value = note.body || '';
    noteArea.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(async () => {
        await api.put('/api/notes', { day: store.day, body: noteArea.value });
        savedMark.textContent = '저장됨';
        setTimeout(() => { savedMark.textContent = ''; }, 1500);
      }, 700);
    });
    const savedMark = h('span.sub', '');
    const noteCard = h('div.card',
      h('h2', '메모', savedMark),
      noteArea,
    );

    mount(root,
      welcome,
      trackerWarning(load),
      reviewNudge,
      gapsCard(gaps, { onChange: load, labels: gapLabels }),
      h('div.grid.cols-2', scoreCard, distribution),
      metrics,
      h('div.grid.cols-2',
        planCard(report, planned, { onChange: load, rhythm }),
        h('div.grid', { style: { gridTemplateColumns: '1fr' } }, focusCard, apps),
      ),
      timeline,
      insightCard,
      h('div.grid.cols-2', taskCard, noteCard),
    );
  }

  await load();

  return {
    refresh: load,
    destroy: () => clearTimeout(noteTimer),
  };
}

/**
 * 세션에 한 줄 붙이기.
 *
 * "25분 집중"만 남으면 나중에 무엇을 했는지 알 수 없다. 한 줄이 있으면 그 기록이
 * 일지·타임시트의 근거가 된다. 태스크 연결도 여기서 뒤늦게 고칠 수 있다.
 */
function openSessionEditor(session, tasks, onDone) {
  openModal((close) => {
    const note = h('input', {
      type: 'text', value: session.note || '', maxlength: LIMITS.SESSION_NOTE,
      placeholder: '무엇을 했나요? 한 줄이면 충분합니다',
    });
    const taskSel = h('select',
      h('option', { value: '' }, '연결 없음'),
      tasks.map((t) => h('option', { value: t.id, selected: t.id === session.task_id }, t.title)),
    );

    const save = async () => {
      await api.patch(`/api/sessions/${session.id}`, {
        note: note.value,
        task_id: taskSel.value || null,
      });
      close();
      toast('저장했습니다', 'ok');
      onDone?.();
    };
    note.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

    const remove = async () => {
      if (!(await confirmDialog('이 세션 기록을 삭제할까요?', { danger: true, okLabel: '삭제' }))) return;
      await api.del(`/api/sessions/${session.id}`);
      close();
      onDone?.();
    };

    return {
      title: `${hhmm(session.started_at)} 세션 (${dur(session.elapsed_sec)})`,
      body: [
        h('label.field', '메모', note),
        h('label.field', '태스크', taskSel),
        session.interruptions
          ? h('div.muted', { style: { fontSize: '12px' } }, `방해 ${session.interruptions}회 기록됨`)
          : null,
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
