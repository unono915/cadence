import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast, pillGroup } from '../lib/ui.js';
import { dur, dayLabel, shiftDay } from '../lib/format.js';
import { store, remembered, remember } from '../lib/store.js';
import { trendChart, barList, rhythmChart, weekdayChart } from '../lib/charts.js';
import { weekInsights } from '../lib/insights.js';
import { openWeeklyReview } from './weekly-review.js';

const DAYS_KEY = 'cadence.reports.days';

const SERIES = [
  { key: 'deep_sec', color: 'var(--good)', label: '몰입' },
  { key: 'meeting_sec', color: '#e0a458', label: '회의' },
  { key: 'comms_sec', color: '#4bb3c4', label: '커뮤니케이션' },
  { key: 'shallow_sec', color: '#9aa0a6', label: '관리·잡무' },
  { key: 'distraction_sec', color: '#d9534f', label: '방해요소' },
];

export async function render(root) {
  const state = { days: remembered(DAYS_KEY, [14, 7, 30, 90]) };

  async function load() {
    const [trend, week, rhythm] = await Promise.all([
      api.get('/api/report/trend', { days: state.days, day: store.day }),
      api.get('/api/report/week', { day: store.day }),
      api.get('/api/report/rhythm', { weeks: 8, day: store.day }),
    ]);
    draw({ trend, week, rhythm });
  }

  function draw({ trend, week, rhythm }) {
    const insights = weekInsights(week, trend);
    const workdays = trend.filter((d) => d.active_sec > 1800);
    const avg = (key) => (workdays.length ? workdays.reduce((s, d) => s + d[key], 0) / workdays.length : 0);

    const header = h('div.row.wrap', { style: { marginBottom: '14px' } },
      pillGroup(
        [{ value: 7, label: '7일' }, { value: 14, label: '14일' }, { value: 30, label: '30일' }, { value: 90, label: '90일' }],
        state.days,
        (v) => { state.days = v; remember(DAYS_KEY, v); load(); },
        { label: '기간' },
      ),
      h('div.spacer'),
      h('button.btn.primary', {
        onclick: () => openWeeklyReview(week, { onDone: load, rhythm }),
        title: '지난주와 비교하고 다음 주에 지킬 것 하나를 정합니다',
      }, '주간 리뷰'),
      h('button.btn', { onclick: () => showExport('day') }, '오늘 요약 (MD)'),
      h('button.btn', { onclick: () => showExport('week') }, '주간 리포트 (MD)'),
      h('button.btn', { onclick: () => openRangeReport() }, '기간 리포트'),
    );

    // 기록이 아직 없으면 0 대신 '—'. 0 은 "0이었다"로 읽혀 오해를 부른다.
    const has = workdays.length > 0;

    /**
     * 평균 점수에서 **미분류가 절반을 넘는 날**은 뺀다.
     *
     * 그런 날의 점수는 하루가 아니라 분류 상태를 잰 값이다. 하루 화면에서는 "이 점수는
     * 아직 하루를 설명하지 못합니다" 라고 말해 놓고 추세에서는 조용히 평균에 섞으면,
     * 경고는 무의미해지고 평균만 이유 없이 낮아진다. 몇 밀을 뺐는지 함께 적는다.
     */
    const scored = workdays.filter((d) => !d.unreliable);
    const dropped = workdays.length - scored.length;
    const avgScore = scored.length
      ? Math.round(scored.reduce((s, d) => s + d.score, 0) / scored.length)
      : null;

    const summary = h('div.grid.cols-4',
      stat('하루 평균 몰입', has ? dur(avg('deep_sec')) : '—',
        has ? `기록된 ${workdays.length}일 기준` : '기록이 쌓이면 나타납니다'),
      stat('하루 평균 활동', has ? dur(avg('active_sec')) : '—'),
      stat('평균 점수', avgScore === null ? '—' : String(avgScore),
        dropped ? `/ 100 · 미분류가 많은 ${dropped}일 제외` : '/ 100'),
      stat('완료 태스크', String(trend.reduce((s, d) => s + d.tasks_done, 0)), `${state.days}일 합계`),
    );

    const chart = h('div.card',
      h('h2', '시간 배분 추세',
        h('div.legend', { style: { marginTop: 0 } },
          SERIES.map((s) => h('div.item', h('span.swatch', { style: { background: s.color } }), s.label)),
        ),
      ),
      trendChart(trend, SERIES, { emptyText: '이 기간에 기록된 활동이 없습니다' }),
    );

    const scoreChart = h('div.card',
      h('h2', 'Cadence 점수 추이', h('span.sub', `최근 ${state.days}일`)),
      trendChart(
        trend.map((d) => ({ day: d.day, score: d.score })),
        [{ key: 'score', color: 'var(--accent)', label: '점수' }],
        { height: 130, valueFormat: (v) => String(Math.round(v)), emptyText: '점수를 매길 만큼 기록이 쌓이지 않았습니다' },
      ),
    );

    const weekCard = h('div.card',
      h('h2', '이번 주', h('span.sub', `${week.days[0]} – ${week.days[6]}`)),
      h('div.grid.cols-3', { style: { marginBottom: '12px' } },
        stat('몰입', dur(week.totals.deep_sec), null, true),
        stat('몰입 블록', dur(week.totals.block_sec), null, true),
        stat('회의', dur(week.totals.meeting_sec), null, true),
      ),
      barList(
        week.daily.map((d) => ({ name: dayLabel(d.day), seconds: d.deep_sec, color: 'var(--good)' })),
        { total: week.totals.deep_sec },
      ),
    );

    // 프로젝트별 시간과 주간 예산.
    // 목표를 정해 둔 프로젝트는 실적 대비 달성률까지 함께 보여 준다.
    const budgeted = week.by_project.filter((p) => p.target_sec);
    const projectCard = h('div.card',
      h('h2', '프로젝트별 시간',
        h('span.sub', budgeted.length ? '막대 위 눈금 = 주간 목표' : '세션·태스크에 연결된 시간'),
      ),
      week.by_project.length
        ? h('div.bar-list',
            week.by_project.map((p) => {
              const cap = Math.max(
                1,
                ...week.by_project.map((x) => Math.max(x.seconds, x.target_sec || 0)),
              );
              const done = p.target_sec ? Math.round((p.seconds / p.target_sec) * 100) : null;
              const tone = done === null ? null
                : done >= 90 ? 'var(--good)' : done >= 50 ? 'var(--warn)' : 'var(--bad)';
              return h('div.bar-row',
                h('span.name', p.name),
                h('span.amt',
                  dur(p.seconds),
                  p.target_sec
                    ? h('span', { style: { color: tone, marginLeft: '6px' } },
                        `${done}% / ${dur(p.target_sec)}`)
                    : null,
                ),
                h('span.track', { style: { position: 'relative' } },
                  h('i', { style: { width: `${Math.max(2, (p.seconds / cap) * 100)}%`, background: p.color } }),
                  p.target_sec
                    ? h('span', {
                        title: `주간 목표 ${dur(p.target_sec)}`,
                        style: {
                          position: 'absolute', top: '-2px', bottom: '-2px',
                          left: `${Math.min(100, (p.target_sec / cap) * 100)}%`,
                          width: '2px', background: 'var(--text-dim)', borderRadius: '1px',
                        },
                      })
                    : null,
                ),
              );
            }),
          )
        : h('div.empty', '집중 세션에 태스크를 연결하면 여기에 쌓입니다'),
      h('div.muted', { style: { fontSize: '12px', marginTop: '10px' } },
        '주간 목표는 태스크 화면에서 프로젝트를 눌러 정합니다.'),
    );

    const accCard = h('div.card',
      h('h2', '추정 정확도',
        h('span.sub', week.estimate_accuracy.samples ? `표본 ${week.estimate_accuracy.samples}개` : ''),
      ),
      week.estimate_accuracy.samples
        ? h('div',
            // 표본 한두 개의 중앙값은 그냥 그 한 건이다. 큼직하게 '2.6배' 라고 띄우면
            // 사람은 그것을 자기 버릇으로 읽는다 — 그러라고 만든 숫자가 아니다.
            week.estimate_accuracy.enough
              ? h('div.stat', { style: { marginBottom: '10px' } },
                  h('span.value', `${week.estimate_accuracy.median_ratio}×`),
                  h('span.label', '중앙값 — 1.0 이면 추정과 실제가 일치'),
                )
              : h('div.hint', { style: { marginBottom: '10px' } },
                  h('span.icon', 'i'),
                  h('span', `표본이 ${week.estimate_accuracy.samples}개뿐이라 아직 경향이라고 부르기 이릅니다. `
                    + '예상 시간을 적은 태스크를 3개 이상 완료하면 중앙값을 냅니다.'),
                ),
            h('div.table-scroll', h('table.data',
              h('thead', h('tr', h('th', '태스크'), h('th', '추정'), h('th', '실제'), h('th', '배율'))),
              h('tbody', week.estimate_accuracy.items.map((i) => h('tr',
                h('td.nowrap', { style: { maxWidth: '260px' } }, i.title),
                h('td.mono', `${i.estimate_min}분`),
                h('td.mono', `${Math.round(i.actual_sec / 60)}분`),
                h('td.mono', {
                  style: { color: i.ratio > 1.3 ? 'var(--warn)' : i.ratio < 0.7 ? 'var(--muted)' : 'var(--good)' },
                }, `${i.ratio}×`),
              ))),
            )),
          )
        : h('div.empty', '예상 시간을 적은 태스크를 완료하면 정확도를 계산합니다'),
    );

    const insightCard = insights.length
      ? h('div.card',
          h('h2', '읽을거리'),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            insights.map((i) => h('div.hint', {
              style: i.kind === 'good'
                ? { background: 'color-mix(in srgb, var(--good) 12%, transparent)', borderColor: 'color-mix(in srgb, var(--good) 32%, transparent)' }
                : i.kind === 'warn'
                  ? { background: 'color-mix(in srgb, var(--warn) 11%, transparent)', borderColor: 'color-mix(in srgb, var(--warn) 30%, transparent)' }
                  : null,
            }, h('span.icon', i.kind === 'good' ? '✓' : i.kind === 'warn' ? '!' : 'i'), h('span', i.text))),
          ),
        )
      : null;

    const table = h('div.card',
      h('h2', '일별 상세'),
      h('div.table-scroll', h('table.data',
        h('thead', h('tr',
          h('th', '날짜'), h('th', '점수'), h('th', '활동'), h('th', '몰입'), h('th', '블록'),
          h('th', '전환/h'), h('th', '세션'), h('th', '완료'),
        )),
        // 기록이 없는 날은 0 이 아니라 '—'. 쉰 날과 "종일 앉아 있었지만 아무것도 못 한 날"은
        // 전혀 다른 이야기인데, 0 으로 나란히 찍어 두면 표에서 구별되지 않는다.
        h('tbody', [...trend].reverse().map((d) => {
          const blank = d.active_sec === 0;
          const cell = (value, style) => h('td.mono', blank ? { style: { color: 'var(--muted)' } } : style, blank ? '—' : value);
          return h('tr', { style: blank ? { opacity: 0.55 } : null },
            h('td.nowrap', dayLabel(d.day)),
            // 미분류가 많은 날은 점수 옆에 표를 달고 흐리게 둔다. 평균에서 뺀 날이
            // 어느 날인지 표에서 짚을 수 없으면 "몇 일 제외" 라는 설명이 공허하다.
            d.unreliable && !blank
              ? h('td.mono', {
                  style: { color: 'var(--muted)' },
                  title: `활동의 ${Math.round(d.unclassified_ratio * 100)}% 가 미분류라 평균에서 뺐습니다`,
                }, `${d.score}?`)
              : cell(String(d.score), {
                  style: { color: d.score >= 70 ? 'var(--good)' : d.score >= 40 ? 'var(--warn)' : 'var(--muted)' },
                }),
            cell(dur(d.active_sec)),
            cell(dur(d.deep_sec)),
            cell(String(d.blocks)),
            cell(String(d.switches_per_hour)),
            // 세션과 완료 태스크는 추적이 꺼져 있어도 생길 수 있으므로 그대로 보여 준다.
            h('td.mono', String(d.sessions)),
            h('td.mono', String(d.tasks_done)),
          );
        })),
      )),
    );

    // --- 업무 리듬 ---
    // 하루치로는 절대 보이지 않는 것: 언제 몰입이 잘 되는가.
    const hourLabel = (h24) => `${String(h24).padStart(2, '0')}시`;
    const rhythmCard = h('div.card',
      h('h2', '업무 리듬',
        h('span.sub', `최근 ${rhythm.weeks}주 · 기록된 ${rhythm.observed_days}일`),
      ),
      rhythm.enough
        ? h('div',
            rhythm.best_window
              ? h('div.hint', { style: { marginBottom: '12px' } },
                  h('span.icon', '◎'),
                  h('span',
                    `몰입이 가장 잘 되는 시간대는 `,
                    h('b', `${hourLabel(rhythm.best_window.start_hour)}–${hourLabel(rhythm.best_window.end_hour)}`),
                    ` 입니다 (자리에 있던 시간의 ${Math.round(rhythm.best_window.deep_ratio * 100)}%가 몰입). `,
                    rhythm.worst_window && rhythm.worst_window.start_hour !== rhythm.best_window.start_hour
                      ? `반대로 ${hourLabel(rhythm.worst_window.start_hour)}–${hourLabel(rhythm.worst_window.end_hour)} 는 ${Math.round(rhythm.worst_window.deep_ratio * 100)}% 에 그칩니다 — 회의와 잡무는 이쪽으로 몰아 보세요.`
                      : '',
                  ),
                )
              : null,
            h('div.muted', { style: { fontSize: '12px', marginBottom: '4px' } },
              '막대 높이 = 그 시간에 자리에 있었을 때 몰입한 비율 · 옅은 배경 = 그 시간대에 앉아 있던 시간'),
            rhythmChart(rhythm.hours, { highlight: rhythm.best_window }),
            h('div', { style: { marginTop: '14px' } },
              h('h2', { style: { marginBottom: '6px' } }, '요일별'),
              weekdayChart(rhythm.weekdays),
              rhythm.best_weekday && rhythm.worst_weekday
                && rhythm.best_weekday.dow !== rhythm.worst_weekday.dow
                ? h('div.muted', { style: { fontSize: '12px', marginTop: '8px' } },
                    `${rhythm.best_weekday.label}요일이 가장 좋고 ${rhythm.worst_weekday.label}요일이 가장 흐트러집니다.`)
                : null,
            ),
          )
        : h('div.empty', '리듬을 읽으려면 며칠 더 기록이 쌓여야 합니다 (최소 3일).'),
    );

    mount(root, header, summary, chart, h('div.grid.cols-2', scoreChart, weekCard),
      insightCard, rhythmCard, h('div.grid.cols-2', projectCard, accCard), table);
  }

  function stat(label, value, sub, small = false) {
    return h(small ? 'div' : 'div.card',
      h('div.stat',
        h('span.value', { style: small ? { fontSize: '19px' } : null }, value),
        h('span.label', label),
        sub ? h('span.delta.muted', sub) : null,
      ),
    );
  }

  async function showExport(kind) {
    const md = await api.getText(`/api/export/${kind}.md`, { day: store.day });
    openModal((close) => {
      const area = h('textarea', { style: { minHeight: '360px', fontFamily: 'var(--mono)', fontSize: '12px' } });
      area.value = md;
      return {
        title: kind === 'day' ? '오늘 요약 (마크다운)' : '주간 리포트 (마크다운)',
        body: [
          h('div.muted', { style: { fontSize: '12px' } }, '그대로 복사해 일지·주간보고에 붙여 넣을 수 있습니다.'),
          area,
        ],
        footer: [
          h('button.btn', { onclick: close }, '닫기'),
          h('button.btn.primary', {
            onclick: async () => {
              try {
                await navigator.clipboard.writeText(md);
                toast('클립보드에 복사했습니다', 'ok');
              } catch {
                area.select();
                document.execCommand('copy');
                toast('복사했습니다', 'ok');
              }
            },
          }, '복사'),
        ],
      };
    });
  }

  function download(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
  }

  /**
   * 임의 기간 리포트.
   *
   * "지난달 이 프로젝트에 몇 시간 썼나", "8/12–9/3 정산" 같은 질문은 주 단위 화면으로는
   * 답할 수 없다. 기간을 직접 정하고, 프로젝트·태스크별 시간을 바로 뽑아 갈 수 있게 한다.
   */
  function openRangeReport() {
    openModal((close) => {
      const today = store.today;
      const from = h('input', { type: 'date', value: shiftDay(today, -29), max: today });
      const to = h('input', { type: 'date', value: today, max: today });
      const body = h('div', h('div.empty', '기간을 고르고 조회를 누르세요.'));

      const preset = (label, days) => h('button.btn.sm', {
        onclick: () => { from.value = shiftDay(today, -(days - 1)); to.value = today; run(); },
      }, label);

      async function run() {
        if (from.value > to.value) { toast('시작일이 종료일보다 늦습니다', 'err'); return; }
        const r = await api.get('/api/report/range', { from: from.value, to: to.value });
        const projectTotal = r.by_project.reduce((s, p) => s + p.seconds, 0);

        body.replaceChildren(
          h('div.grid.cols-3', { style: { marginBottom: '12px' } },
            stat('활동', dur(r.active_sec), `근무일 ${r.workdays}일`, true),
            stat('몰입', dur(r.deep_sec), r.workdays ? `하루 평균 ${dur(r.deep_sec / r.workdays)}` : null, true),
            stat('완료 태스크', `${r.tasks_done}개`, `세션 ${r.sessions.n}회`, true),
          ),
          r.by_project.length
            ? h('div',
                h('div.section-title', '프로젝트별'),
                barList(r.by_project.map((p) => ({ name: p.name, seconds: p.seconds, color: p.color })),
                  { total: projectTotal }),
              )
            : null,
          r.by_task.length
            ? h('div',
                h('div.section-title', { style: { marginTop: '14px' } }, `태스크별 (${r.by_task.length}개)`),
                h('div.table-scroll', { style: { maxHeight: '260px' } }, h('table.data',
                  h('thead', h('tr', h('th', '태스크'), h('th', '프로젝트'), h('th', '시간'))),
                  h('tbody', r.by_task.map((t) => h('tr',
                    h('td', { style: { maxWidth: '260px', wordBreak: 'break-word' } }, t.title),
                    h('td.nowrap.muted', t.project_name),
                    h('td.mono.nowrap', dur(t.seconds)),
                  ))),
                )),
              )
            : h('div.empty', '이 기간에 태스크에 연결된 시간이 없습니다'),
        );
      }

      return {
        title: '기간 리포트',
        body: [
          h('div.row.wrap',
            h('label.field', { style: { flex: 1, minWidth: '130px' } }, '시작일', from),
            h('label.field', { style: { flex: 1, minWidth: '130px' } }, '종료일', to),
            h('button.btn.primary', { style: { alignSelf: 'flex-end' }, onclick: run }, '조회'),
          ),
          h('div.row.wrap', preset('최근 7일', 7), preset('최근 30일', 30), preset('최근 90일', 90)),
          body,
        ],
        footer: [
          h('button.btn', {
            onclick: () => download(
              `/api/export/tasks.csv?from=${from.value}&to=${to.value}`,
              `cadence-tasks-${from.value}_${to.value}.csv`,
            ),
          }, '태스크별 CSV'),
          h('button.btn', {
            onclick: () => download(
              `/api/export/activity.csv?from=${from.value}&to=${to.value}`,
              `cadence-activity-${from.value}_${to.value}.csv`,
            ),
          }, '활동 CSV'),
          h('div.spacer'),
          h('button.btn.primary', {
            onclick: async () => {
              const md = await api.getText('/api/export/range.md', { from: from.value, to: to.value });
              try {
                await navigator.clipboard.writeText(md);
                toast('마크다운을 클립보드에 복사했습니다', 'ok');
              } catch {
                toast('복사에 실패했습니다', 'err');
              }
            },
          }, '마크다운 복사'),
          h('button.btn', { onclick: close }, '닫기'),
        ],
      };
    });
  }

  await load();
  return { refresh: load };
}

