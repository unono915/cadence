import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast, confirmDialog, pillGroup, clickable } from '../lib/ui.js';
import { dur, hhmm, pct } from '../lib/format.js';
import { store, remembered, remember } from '../lib/store.js';
import { timelineStrip, barList } from '../lib/charts.js';
import { openActivitySearch } from './activity-search.js';
import { unclassifiedCard, openLargestUnclassified } from './unclassified.js';
import { LIMITS } from '../lib/limits.js';

const GROUP_KEY = 'cadence.timeline.group';
const ROWS_KEY = 'cadence.timeline.rows';

export async function render(root) {
  const state = {
    grouping: remembered(GROUP_KEY, ['app', 'category']),
    // 기본은 '합쳐 보기'. 하루치 세그먼트를 그대로 늘어놓으면 수백 줄이 되어
    // 무엇을 했는지가 오히려 안 보인다.
    rows: remembered(ROWS_KEY, ['merged', 'raw']),
    minSec: 30,
    // 오늘 화면에서 "분류하러 가기" 로 넘어온 경우에만 참.
    autoClassify: /[?&]classify=1(&|$)/.test(location.hash),
  };

  async function load() {
    const day = store.day;
    const [segments, summary, report, tasks, unclassified] = await Promise.all([
      api.get('/api/activity', { day, min_sec: state.minSec }),
      api.get('/api/activity/summary', { day }),
      api.get('/api/report/day', { day }),
      api.get('/api/tasks', { status: 'todo,doing' }),
      api.get('/api/activity/unclassified', { days: 14, to: day }),
    ]);
    if (store.day !== day) return;
    draw({ segments, summary, report, tasks, unclassified });

    // 오늘 화면의 "분류하러 가기" 는 여기까지 데려온 뒤 곧바로 정리창을 연다.
    // 한 번만 연다 — 다시 그릴 때마다 창이 튀어나오면 아무것도 할 수 없다.
    if (state.autoClassify) {
      state.autoClassify = false;
      history.replaceState(null, '', '#/timeline');
      openLargestUnclassified(unclassified, load);
    }
  }

  function draw({ segments, summary, report, tasks, unclassified }) {
    const total = summary.active_sec;

    const strip = h('div.card',
      h('h2', '하루 타임라인',
        h('div.row',
          h('span.sub', `활동 ${dur(summary.active_sec)} · 자리비움 ${dur(summary.idle_sec)}`),
          h('button.btn.sm', {
            onclick: () => openRangeAssign(tasks, load),
            title: '시간 구간을 통째로 태스크에 연결합니다',
          }, '구간 지정'),
          h('button.btn.sm', {
            onclick: () => openActivitySearch(),
            title: '기간 전체에서 창 제목·앱 이름으로 찾기',
          }, '🔍 전체 검색'),
        ),
      ),
      timelineStrip(segments, {
        blocks: report.deep_blocks,
        showNow: store.day === store.today,
        onPick: (s) => openSegment(s, tasks),
        onRange: (from, to) => openRangeAssign(tasks, load, { from, to }),
      }),
      h('div.muted', { style: { fontSize: '11px', marginTop: '4px' } },
        '막대를 누르면 그 기록을, 가로로 끌면 그 구간 전체를 태스크에 연결합니다.'),
    );

    const breakdown = h('div.card',
      h('h2', '집계',
        pillGroup(
          [{ value: 'app', label: '앱' }, { value: 'category', label: '카테고리' }],
          state.grouping,
          (v) => { state.grouping = v; remember(GROUP_KEY, v); load(); },
          { label: '집계 기준' },
        ),
      ),
      state.grouping === 'app'
        ? barList(
            summary.by_app.map((a) => ({
              name: a.app, seconds: a.seconds, color: a.category_color,
              title: `${a.app} — ${a.category_name}`, raw: a,
            })),
            { total, onClick: (i) => openAppDetail(i.raw) },
          )
        : barList(
            summary.by_category.map((c) => ({ name: c.name, seconds: c.seconds, color: c.color })),
            { total },
          ),
    );

    const blocks = h('div.card',
      h('h2', '몰입 블록', h('span.sub', `${report.deep_blocks.length}개 · 합계 ${dur(report.deep_block_sec)}`)),
      report.deep_blocks.length
        ? h('div.table-scroll', h('table.data',
            h('thead', h('tr', h('th', '구간'), h('th', '몰입'), h('th', '이탈'), h('th', '주 사용'))),
            h('tbody', report.deep_blocks.map((b) => h('tr',
              h('td.mono', `${hhmm(b.start)} – ${hhmm(b.end)}`),
              h('td.mono', dur(b.deep_sec)),
              h('td.mono.muted', b.breaks_sec ? dur(b.breaks_sec) : '—'),
              h('td.nowrap', b.top_app),
            ))),
          ))
        : h('div.empty', `${report.targets.block_min}분 이상 이어진 몰입 구간이 없습니다`),
    );

    const rows = state.rows === 'merged' ? mergeRuns(segments) : segments.slice();
    rows.reverse();

    const table = h('div.card',
      h('h2', '활동 기록',
        h('div.row',
          h('span.sub', `${segments.length}건 · ${state.minSec}초 이상`),
          pillGroup(
            [
              { value: 'merged', label: '합쳐 보기', title: '같은 앱을 이어서 쓴 구간을 한 줄로' },
              { value: 'raw', label: '펼쳐 보기' },
            ],
            state.rows,
            (v) => { state.rows = v; remember(ROWS_KEY, v); load(); },
            { label: '기록 보기' },
          ),
          h('button.btn.sm', { onclick: () => openManual(tasks) }, '＋ 직접 추가'),
        ),
      ),
      rows.length
        ? h('div.table-scroll', h('table.data',
            h('thead', h('tr',
              h('th', '시각'), h('th', '길이'), h('th', '앱'), h('th', '창 제목'), h('th', '카테고리'), h('th', '태스크'), h('th', ''),
            )),
            h('tbody', rows.map((s) => h('tr',
              h('td.mono.nowrap', s.parts ? `${hhmm(s.started_at)}–${hhmm(s.ended_at)}` : hhmm(s.started_at)),
              h('td.mono.nowrap', dur(s.seconds)),
              h('td.nowrap', { style: { maxWidth: '160px' } }, s.idle ? h('span.muted', '자리비움') : s.app),
              h('td.nowrap', {
                style: { maxWidth: '320px', color: 'var(--text-dim)' },
                title: s.titleTooltip || s.title,
              }, s.titleLabel ?? (s.title || '—')),
              h('td', s.idle ? h('span.muted', '—') : h('span.tag',
                h('span.swatch', { style: { background: s.category_color || 'var(--muted)' } }),
                s.category_name || '미분류',
              )),
              h('td.nowrap.muted', { style: { maxWidth: '160px' } }, s.task_title || '—'),
              h('td', h('button.btn.ghost.sm', {
                onclick: () => (s.parts ? openRun(s, tasks) : openSegment(s, tasks)),
                'aria-label': '자세히 보기',
              }, '⋯')),
            ))),
          ))
        : h('div.empty', '이 날의 활동 기록이 없습니다'),
    );

    mount(root,
      unclassifiedCard(unclassified, { onChange: load }),
      strip,
      h('div.grid.cols-2', breakdown, blocks),
      table);
  }

  /**
   * 같은 앱을 이어서 쓴 구간을 한 줄로 접는다.
   *
   * 자동 추적은 창 제목이 바뀔 때마다 세그먼트를 나누므로, 편집기에서 파일을 옮겨 다니면
   * 30분 작업이 스무 줄이 된다. 앱이 바뀌지 않고 사이 공백이 짧으면 하나의 '작업 구간'으로 본다.
   */
  function mergeRuns(segments, { gapSec = 120 } = {}) {
    const out = [];
    for (const s of segments) {
      const prev = out[out.length - 1];
      const continues = prev
        && prev.app === s.app
        && prev.idle === s.idle
        && s.started_at - prev.ended_at <= gapSec * 1000;

      if (!continues) {
        out.push({ ...s, parts: [s] });
        continue;
      }

      // 수동 입력이 추적 기록과 겹치는 경우가 있어 뒤 조각이 더 일찍 끝날 수 있다.
      // 그대로 대입하면 구간이 거꾸로 줄어들므로 항상 늦은 쪽을 취한다.
      prev.ended_at = Math.max(prev.ended_at, s.ended_at);
      prev.parts.push(s);
      // 구간을 대표하는 분류는 가장 오래 머문 조각을 따른다.
      const longest = prev.parts.reduce((a, b) => (b.seconds > a.seconds ? b : a));
      prev.category_name = longest.category_name;
      prev.category_color = longest.category_color;
      prev.category_id = longest.category_id;
      prev.task_title = prev.task_title || s.task_title;
    }

    for (const run of out) {
      // 길이는 조각들의 단순 합이 아니라 합집합으로 센다.
      // 수동 입력이 추적 기록과 겹치면 같은 시간이 두 번 세어져 실제보다 부풀기 때문.
      run.seconds = unionSeconds(run.parts);

      const titles = [...new Set(run.parts.map((p) => p.title).filter(Boolean))];
      run.titleLabel = titles.length === 0
        ? '—'
        : titles.length === 1 ? titles[0] : `${titles[0]} 외 ${titles.length - 1}개`;
      run.titleTooltip = titles.join('\n');
    }
    return out;
  }

  /** 겹치는 구간을 하나로 합쳐 실제로 흐른 시간만 센다. */
  function unionSeconds(parts) {
    const sorted = [...parts].sort((a, b) => a.started_at - b.started_at);
    let total = 0;
    let start = null;
    let end = null;
    for (const p of sorted) {
      if (end === null || p.started_at > end) {
        if (end !== null) total += end - start;
        start = p.started_at;
        end = p.ended_at;
      } else {
        end = Math.max(end, p.ended_at);
      }
    }
    if (end !== null) total += end - start;
    return Math.round(total / 1000);
  }

  /** 합쳐진 구간 안을 들여다본다. */
  function openRun(run, tasks) {
    if (run.parts.length === 1) { openSegment(run.parts[0], tasks); return; }
    openModal(() => ({
      title: `${run.app} · ${hhmm(run.started_at)}–${hhmm(run.ended_at)} (${dur(run.seconds)})`,
      body: [
        h('div.muted', { style: { fontSize: '12px' } },
          `${run.parts.length}개 구간으로 이어진 작업입니다. 줄을 눌러 개별 기록을 고칠 수 있습니다.`),
        h('div.table-scroll', h('table.data',
          h('thead', h('tr', h('th', '시각'), h('th', '길이'), h('th', '창 제목'), h('th', '카테고리'))),
          h('tbody', run.parts.map((p) => h('tr', clickable({
            style: { cursor: 'pointer' },
          }, () => openSegment(p, tasks), `${hhmm(p.started_at)} 기록 열기`),
            h('td.mono.nowrap', hhmm(p.started_at)),
            h('td.mono.nowrap', dur(p.seconds)),
            h('td', { style: { maxWidth: '360px', wordBreak: 'break-word' } }, p.title || '(제목 없음)'),
            h('td.nowrap.muted', p.category_name || '미분류',
              p.pinned ? h('span', { style: { color: 'var(--accent)', marginLeft: '4px' }, title: '직접 정한 분류 — 규칙이 덮지 않습니다' }, '·직접') : null),
          ))),
        )),
      ],
    }));
  }

  /** 세그먼트 하나의 분류/귀속을 고친다. */
  function openSegment(segment, tasks) {
    openModal((close) => {
      const cat = h('select',
        h('option', { value: '' }, '분류 없음'),
        store.categories.map((c) => h('option', { value: c.id, selected: c.id === segment.category_id }, c.name)),
      );
      const task = h('select',
        h('option', { value: '' }, '연결 없음'),
        tasks.map((t) => h('option', { value: t.id, selected: t.id === segment.task_id }, t.title)),
      );

      const save = async () => {
        await api.patch(`/api/activity/${segment.id}`, {
          category_id: cat.value || null,
          task_id: task.value || null,
        });
        close();
        toast('수정했습니다', 'ok');
        load();
      };

      const teach = async () => {
        if (!cat.value) { toast('먼저 카테고리를 고르세요', 'err'); return; }
        const res = await api.post('/api/rules', {
          field: 'app', pattern: segment.app, category_id: Number(cat.value), apply_existing: true,
        });
        close();
        toast(`규칙을 추가했고 기존 기록 ${res.updated}건을 갱신했습니다`, 'ok');
        load();
      };

      const remove = async () => {
        if (!(await confirmDialog('이 기록을 삭제할까요?', { danger: true, okLabel: '삭제' }))) return;
        await api.del(`/api/activity/${segment.id}`);
        close();
        load();
      };

      return {
        title: '활동 기록',
        body: [
          h('dl.kv',
            h('dt', '시각'), h('dd.mono', `${hhmm(segment.started_at)} – ${hhmm(segment.ended_at)} (${dur(segment.seconds)})`),
            h('dt', '앱'), h('dd', segment.app),
            h('dt', '제목'), h('dd', { style: { wordBreak: 'break-word' } }, segment.title || '—'),
          ),
          h('label.field', '카테고리', cat),
          h('label.field', '태스크에 연결', task),
          // 손으로 정해 둔 기록은 규칙이 건드리지 않는다. 그 사실을 말해 주지 않으면
          // "규칙을 만들었는데 이 줄만 안 바뀐다" 로 보인다.
          segment.pinned
            ? h('div.hint',
                h('span.icon', '✓'),
                h('span', '이 분류는 직접 정한 것입니다. 규칙을 새로 만들어도 이 기록은 그대로 둡니다. '
                  + '다시 규칙에 맡기려면 카테고리를 "분류 없음" 으로 두고 저장하세요.'),
              )
            : null,
          h('div.hint',
            h('span.icon', 'i'),
            h('span', `"${segment.app}" 을(를) 항상 이 카테고리로 분류하려면 아래 버튼을 누르세요. 과거 기록도 함께 바뀝니다.`),
          ),
        ],
        footer: [
          h('button.btn.danger', { onclick: remove }, '삭제'),
          h('div.spacer'),
          h('button.btn', { onclick: teach }, '이 앱을 항상 이렇게'),
          h('button.btn.primary', { onclick: save }, '이 기록만 수정'),
        ],
      };
    });
  }

  /** 앱 하나를 창 제목별로 파고든다 — "브라우저에서 뭘 했나"를 보는 용도. */
  async function openAppDetail(app) {
    const detail = await api.get('/api/activity/app', { day: store.day, app: app.app });
    const total = detail.reduce((s, d) => s + d.seconds, 0);
    openModal(() => ({
      title: app.app,
      body: [
        h('div.muted', { style: { fontSize: '12px' } }, `${dur(total)} · ${detail.length}개 창 · ${app.category_name}`),
        detail.length
          ? h('div.table-scroll', h('table.data',
              h('thead', h('tr', h('th', '창 제목'), h('th', '시간'), h('th', '비중'))),
              h('tbody', detail.map((d) => h('tr',
                h('td', { style: { maxWidth: '380px', wordBreak: 'break-word' } }, d.title || '(제목 없음)'),
                h('td.mono.nowrap', dur(d.seconds)),
                h('td.mono.muted', `${pct(d.seconds, total)}%`),
              ))),
            ))
          : h('div.empty', '세부 기록 없음'),
      ],
    }));
  }

  /** 자동 추적이 놓친 오프라인 작업을 채워 넣는다. */
  function openManual(tasks) {
    openModal((close) => {
      const now = new Date();
      const timeInput = h('input', { type: 'text', value: `${String(now.getHours()).padStart(2, '0')}:00`, placeholder: 'HH:MM' });
      const minutes = h('input', { type: 'number', value: 30, min: 1, step: 5 });
      const label = h('input', {
        type: 'text', placeholder: '예: 팀 스탠드업, 전화 상담, 오프라인 검토', maxlength: LIMITS.ACTIVITY_APP,
      });
      const cat = h('select',
        store.categories.map((c) => h('option', { value: c.id, selected: c.name === '회의' }, c.name)),
      );
      const task = h('select',
        h('option', { value: '' }, '연결 없음'),
        tasks.map((t) => h('option', { value: t.id }, t.title)),
      );

      // 이 구간에 이미 무엇이 기록돼 있는지 미리 보여 준다.
      //
      // 수동 입력은 그 시간대의 기존 기록을 **대신한다**. 그러지 않으면 자리비움 30분 위에
      // 회의 30분이 얹혀 하루가 한 시간 늘어난다. 다만 무엇이 사라지는지 모르고 누르면
      // 곤란하므로, 누르기 전에 보여 준다.
      const overlapHint = h('div.hint', { hidden: true });

      const startedAtFrom = (text) => {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(text).trim());
        if (!m) return null;
        const [y, mo, d] = store.day.split('-').map(Number);
        return new Date(y, mo - 1, d, Number(m[1]), Number(m[2])).getTime();
      };

      async function refreshOverlap() {
        const startedAt = startedAtFrom(timeInput.value);
        const mins = Number(minutes.value);
        if (startedAt === null || !(mins > 0)) { overlapHint.hidden = true; return; }
        let data;
        try {
          data = await api.get('/api/activity/manual/preview', { started_at: startedAt, minutes: mins });
        } catch {
          overlapHint.hidden = true;
          return;
        }
        if (!data.count) { overlapHint.hidden = true; return; }
        overlapHint.hidden = false;
        overlapHint.replaceChildren(
          h('span.icon', '!'),
          h('span',
            h('b', `이 시간대의 기존 기록 ${data.count}건이 이것으로 대체됩니다`),
            h('span', { style: { display: 'block', fontSize: '11px', marginTop: '3px' } },
              data.rows.map((r) => `${r.idle ? '자리비움' : r.app} ${dur(r.seconds)}`).join(', ')),
          ),
        );
      }
      timeInput.addEventListener('change', refreshOverlap);
      timeInput.addEventListener('input', refreshOverlap);
      minutes.addEventListener('change', refreshOverlap);
      refreshOverlap();

      const submit = async () => {
        const startedAt = startedAtFrom(timeInput.value);
        if (startedAt === null) { toast('시각은 HH:MM 형식으로 입력하세요', 'err'); return; }
        await api.post('/api/activity/manual', {
          started_at: startedAt,
          minutes: Number(minutes.value),
          app: label.value.trim() || '오프라인 작업',
          title: '',
          category_id: Number(cat.value),
          task_id: task.value || null,
        });
        close();
        toast('추가했습니다', 'ok');
        load();
      };

      return {
        title: '시간 직접 추가',
        body: [
          h('label.field', '내용', label),
          h('div.grid.cols-2',
            h('label.field', '시작 시각', timeInput),
            h('label.field', '길이 (분)', minutes),
          ),
          overlapHint,
          h('div.grid.cols-2',
            h('label.field', '카테고리', cat),
            h('label.field', '태스크', task),
          ),
        ],
        footer: [
          h('button.btn', { onclick: close }, '취소'),
          h('button.btn.primary', { onclick: submit }, '추가'),
        ],
      };
    });
  }

  await load();
  return { refresh: load };
}

/**
 * 시간 구간을 통째로 태스크에 연결한다.
 *
 * 자동 추적은 창 제목이 바뀔 때마다 기록을 나눈다. 두 시간짜리 작업 하나가 수십 줄이라,
 * 한 줄씩 눌러 태스크에 연결하라고 하면 아무도 하지 않는다 — 그래서 태스크별 시간은
 * 집중 세션을 켠 사람에게만 쌓이고 나머지는 영영 비어 있다. 여기가 그 구멍을 메운다.
 *
 * 무엇이 바뀌는지 먼저 보여 준다. 시간 구간을 눈으로 확인하지 않고 누르면
 * 엉뚱한 두 시간이 통째로 다른 태스크에 붙는데, 되돌리기가 번거롭다.
 */
function openRangeAssign(tasks, onDone, prefill = null) {
  openModal((close) => {
    const startHour = Number(store.settings.day_start_hour || 4);
    const [y, m, d] = store.day.split('-').map(Number);
    const dayStart = new Date(y, m - 1, d, startHour, 0, 0, 0).getTime();

    /** 'HH:MM' → epoch ms. 업무일 시작보다 이른 시각은 다음 날로 본다(새벽 작업). */
    const toTs = (hhmmText) => {
      const [hh, mi] = String(hhmmText || '').split(':').map(Number);
      if (!Number.isFinite(hh) || !Number.isFinite(mi)) return null;
      const ts = new Date(y, m - 1, d, hh, mi, 0, 0).getTime();
      // 하루를 더할 때는 밀리초가 아니라 달력 날짜로 — 서머타임 전환일에는 하루가 23·25시간이다.
      return ts < dayStart ? new Date(y, m - 1, d + 1, hh, mi, 0, 0).getTime() : ts;
    };

    const pad = (v) => String(v).padStart(2, '0');
    const asTime = (ts) => {
      const d = new Date(ts);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    // 타임라인에서 끌어서 왔다면 그 구간을 그대로 채운다 — 숫자를 옮겨 적게 하지 않는다.
    const now = new Date();
    const fromInput = h('input', {
      type: 'time',
      value: prefill ? asTime(prefill.from) : `${pad(Math.max(startHour, now.getHours() - 2))}:00`,
    });
    const toInput = h('input', {
      type: 'time',
      value: prefill ? asTime(prefill.to) : `${pad(now.getHours())}:00`,
    });
    const taskSel = h('select',
      h('option', { value: '' }, '바꾸지 않음'),
      tasks.map((t) => h('option', { value: t.id }, t.title)),
    );
    const catSel = h('select',
      h('option', { value: '' }, '바꾸지 않음'),
      store.categories.map((c) => h('option', { value: c.id }, c.name)),
    );

    const preview = h('div.hint', h('span.icon', 'i'), h('span', '시간을 정하면 무엇이 바뀔지 보여 드립니다.'));
    const apply = h('button.btn.primary', { disabled: true }, '지정');
    let range = null;

    async function refreshPreview() {
      const from = toTs(fromInput.value);
      const to = toTs(toInput.value);
      apply.disabled = true;
      range = null;

      if (from === null || to === null) return;
      if (to <= from) {
        preview.replaceChildren(h('span.icon', '!'), h('span', '끝 시각이 시작보다 뒤여야 합니다.'));
        return;
      }
      let data;
      try {
        data = await api.get('/api/activity/range', { from, to });
      } catch {
        return;
      }
      if (!data.count) {
        preview.replaceChildren(h('span.icon', '!'), h('span', '이 구간에는 기록된 활동이 없습니다.'));
        return;
      }
      range = { from, to };
      apply.disabled = false;
      preview.replaceChildren(
        h('span.icon', 'i'),
        h('span',
          h('b', `기록 ${data.count}건 · ${dur(data.seconds)}`),
          h('span', { style: { display: 'block', fontSize: '11px', marginTop: '3px' } },
            `${hhmm(data.first_at)}–${hhmm(data.last_at)} · `
            + data.apps.map((a) => `${a.app} ${dur(a.seconds)}`).join(', ')),
        ),
      );
    }

    fromInput.addEventListener('change', refreshPreview);
    toInput.addEventListener('change', refreshPreview);
    refreshPreview();

    apply.onclick = async () => {
      if (!range) return;
      const body = { ...range };
      if (taskSel.value) body.task_id = Number(taskSel.value);
      if (catSel.value) body.category_id = Number(catSel.value);
      if (!('task_id' in body) && !('category_id' in body)) {
        toast('연결할 태스크나 카테고리를 고르세요', 'err');
        return;
      }
      const res = await api.post('/api/activity/range', body);
      close();
      toast(`${res.updated}건을 지정했습니다`, 'ok');
      onDone?.();
    };

    return {
      title: '구간 지정',
      body: [
        h('div.muted', { style: { fontSize: '12px' } },
          '이 시간대에 걸친 활동 기록을 한 번에 태스크나 카테고리로 지정합니다. '
          + '자리를 비운 구간은 건드리지 않습니다. '
          // 이 말이 없으면 "규칙을 만들었는데 이 구간만 안 바뀐다" 로 보인다.
          + '카테고리를 지정하면 그 기록은 직접 정한 것으로 남아, 나중에 규칙을 만들어도 그대로 있습니다.'),
        h('div.grid.cols-2',
          h('label.field', '시작', fromInput),
          h('label.field', '끝', toInput),
        ),
        preview,
        h('label.field', '태스크에 연결', taskSel),
        h('label.field', '카테고리', catSel),
      ],
      footer: [
        h('button.btn', { onclick: close }, '닫기'),
        apply,
      ],
    };
  });
}
