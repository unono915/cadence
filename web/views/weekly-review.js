import { h } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { openModal, toast } from '../lib/ui.js';
import { loadBase } from '../lib/store.js';
import { dur, dayLabel, shiftDay } from '../lib/format.js';
import { lastCommitment } from '../lib/insights.js';
import { LIMITS } from '../lib/limits.js';

/** 약속 한 줄에 붙는 머리말. 입력칸의 상한을 여기에 맞춰 깎는다. */
const COMMITMENT_PREFIX = '이번 주 약속 — ';

/**
 * 주간 리뷰.
 *
 * 하루 단위로는 잡음이 크다. 습관이 실제로 바뀌는지는 주 단위로만 보인다.
 * 그래서 이 화면은 "얼마나 했나"보다 **지난주 대비 어디로 가고 있나**와
 * **다음 주에 지킬 것 하나**에 집중한다.
 */
/**
 * 걸린 읽을거리가 하나라도 있을 때만 절을 낸다.
 *
 * 기록이 없는 첫 주에는 아무것도 걸리지 않는데, 그때 제목만 덩그러니 남으면
 * 아래 내용이 잘려 나간 것처럼 보인다. 빈 제목은 "여기 뭔가 있어야 하는데" 로 읽힌다.
 */
function insightBox(...items) {
  const shown = items.filter(Boolean);
  if (!shown.length) return null;
  return h('div',
    h('div.section-title', { style: { marginTop: '6px' } }, '읽을거리'),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', fontSize: '13px' } }, shown),
  );
}

export function openWeeklyReview(week, { onDone, rhythm = null } = {}) {
  openModal((close) => {
    const t = week.totals;
    const p = week.previous;

    const delta = (now, before, { higherIsBetter = true } = {}) => {
      if (!before) return h('span.muted', '지난주 기록 없음');
      const diff = now - before;
      if (Math.abs(diff) < 900) return h('span.muted', '지난주와 비슷');
      const good = higherIsBetter ? diff > 0 : diff < 0;
      return h(`span.delta.${good ? 'up' : 'down'}`,
        `${diff > 0 ? '+' : '−'}${dur(Math.abs(diff))}`);
    };

    const row = (label, value, deltaEl) => h('div.row', {
      style: { justifyContent: 'space-between', gap: '12px', fontSize: '13px' },
    },
      h('span.muted', label),
      h('div.row', { style: { gap: '8px' } }, h('span', value), deltaEl),
    );

    const budgeted = week.by_project.filter((x) => x.target_sec);
    const missed = budgeted.filter((x) => x.ratio < 0.75);
    const hit = budgeted.filter((x) => x.ratio >= 0.9);

    const best = [...week.daily].sort((a, b) => b.block_sec - a.block_sec)[0];
    const acc = week.estimate_accuracy;

    const commitment = h('input', {
      // 약속도 머리말을 달고 노트에 한 줄로 붙는다. 그만큼 빼 둔다.
      type: 'text', maxlength: LIMITS.NOTE_LINE - COMMITMENT_PREFIX.length,
      placeholder: '예: 오전 10–12시는 메신저를 닫고 한 가지만 한다',
    });

    /**
     * 지난 리뷰에서 한 약속을 되짚는다.
     *
     * 여태 이 화면은 약속을 **받기만** 했다. 아무도 다시 묻지 않으니 그 한 줄은
     * 월요일 노트에 적히고 그걸로 끝이었다 — 약속을 받는 의식만 있고 고리가 닫히지 않는다.
     * 지켰는지 한 번 물어야 다음 약속이 진지해진다.
     *
     * 약속은 이 주 월요일 노트에 들어 있다(지난주 리뷰가 거기에 적었다).
     * 답은 다시 그 노트에 남긴다 — 새 표를 만들 만큼의 일이 아니고,
     * 사용자가 자기 노트에서 흐름을 그대로 읽을 수 있다.
     */
    const promiseBox = h('div');
    let promiseText = null;
    let answered = null;
    let kept = null;

    const paintPromise = () => {
      if (!promiseText) return;
      const choice = (value, label) => h('button.btn.sm', {
        class: kept === value ? 'primary' : '',
        'aria-pressed': String(kept === value),
        onclick: () => { kept = value; paintPromise(); },
      }, label);

      promiseBox.replaceChildren(
        h('div.section-title', { style: { marginTop: '6px' } }, '지난 리뷰에서 한 약속'),
        h('div', {
          style: {
            padding: '9px 11px', borderRadius: 'var(--radius-sm)',
            background: 'var(--panel-2)', fontSize: '13px',
          },
        },
          h('div', { style: { marginBottom: answered ? 0 : '8px' } }, `"${promiseText}"`),
          // 이미 답한 약속을 또 물으면 리뷰를 열 때마다 같은 질문이 반복되고 노트에 같은 줄이 쌓인다.
          answered
            ? h('div.muted', { style: { fontSize: '12px', marginTop: '6px' } }, `되짚음 — ${answered}`)
            : h('div.row.wrap', { style: { gap: '6px' } },
                h('span.muted', { style: { fontSize: '12px', marginRight: '4px' } }, '지켰나요?'),
                choice('kept', '지켰다'),
                choice('partly', '반쯤'),
                choice('missed', '못 지켰다'),
              ),
        ),
      );
    };

    api.get('/api/notes', { day: week.days[0] })
      .then((note) => {
        const found = lastCommitment(note.body);
        if (!found) return;
        promiseText = found.text;
        answered = found.answer;
        paintPromise();
      })
      .catch(() => {});

    const submit = async () => {
      const text = commitment.value.trim();

      // 지난 약속의 결과를 먼저 그 주 노트에 남긴다.
      if (promiseText && kept && !answered) {
        const label = { kept: '지켰다', partly: '반쯤 지켰다', missed: '못 지켰다' }[kept];
        await api.post('/api/notes/append', {
          day: week.days[0],
          text: `지난 약속 되짚기 — ${label} ("${promiseText}")`,
        });
      }

      if (text) {
        // 다음 주 월요일 노트에 남긴다 — 리뷰가 다짐으로 끝나지 않도록.
        const nextMonday = shiftDay(week.days[6], 1);
        await api.post('/api/notes/append', { day: nextMonday, text: COMMITMENT_PREFIX + text });
      }
      // 이 주를 리뷰했다고 기록해 두면 같은 안내가 다시 뜨지 않는다.
      await api.patch('/api/settings', { last_weekly_review: week.days[0] });
      await loadBase();
      close();
      toast(text ? '다음 주 월요일 노트에 남겼습니다' : '리뷰를 마쳤습니다', 'ok');
      onDone?.();
    };
    commitment.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    return {
      title: `주간 리뷰 (${week.days[0]} – ${week.days[6]})`,
      body: [
        week.complete
          ? null
          : h('div.muted', { style: { fontSize: '12px' } },
              `이번 주는 아직 ${week.elapsed_days}일째입니다. 비교는 지난주의 같은 ${week.previous.compared_days}일과 맞춰 계산했습니다.`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
          row('몰입 시간', dur(t.deep_sec), delta(t.deep_sec, p.deep_sec)),
          row('몰입 블록 안의 시간', dur(t.block_sec), delta(t.block_sec, p.block_sec)),
          row('회의', dur(t.meeting_sec), delta(t.meeting_sec, p.meeting_sec, { higherIsBetter: false })),
          row('방해요소', dur(t.distraction_sec), delta(t.distraction_sec, p.distraction_sec, { higherIsBetter: false })),
          row('완료 태스크', `${t.tasks_done}개`,
            p.tasks_done ? h('span.muted', `지난주 ${p.tasks_done}개`) : h('span.muted', '—')),
        ),

        budgeted.length
          ? h('div',
              h('div.section-title', { style: { marginTop: '6px' } }, '주간 목표'),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '13px' } },
                budgeted.map((x) => h('div.row', { style: { justifyContent: 'space-between' } },
                  h('span', h('span.swatch', {
                    style: { background: x.color, display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', marginRight: '6px' },
                  }), x.name),
                  h('span', {
                    style: { color: x.ratio >= 0.9 ? 'var(--good)' : x.ratio >= 0.5 ? 'var(--warn)' : 'var(--bad)' },
                  }, `${Math.round(x.ratio * 100)}% · ${dur(x.seconds)} / ${dur(x.target_sec)}`),
                )),
              ),
            )
          : null,

        // 읽을거리는 걸리는 것이 하나도 없을 수 있다 — 기록이 없는 첫 주가 특히 그렇다.
        // 그때 제목만 남으면 아래가 잘려 나간 것처럼 보인다. 내용이 있을 때만 낸다.
        insightBox(
            best && best.block_sec > 0
              ? h('div.hint', h('span.icon', '✓'),
                  h('span', `가장 좋았던 날은 ${dayLabel(best.day)} — 몰입 블록 ${dur(best.block_sec)}. 그날 무엇이 달랐는지 기억나나요?`))
              : null,
            missed.length
              ? h('div.hint', { style: { background: 'color-mix(in srgb, var(--warn) 11%, transparent)' } },
                  h('span.icon', '!'),
                  h('span', `${missed.map((x) => x.name).join(', ')} 은(는) 목표의 절반 남짓에 그쳤습니다. 목표가 과했던 것인지, 시간을 뺏긴 것인지 정하고 넘어가세요.`))
              : null,
            hit.length && !missed.length
              ? h('div.hint', h('span.icon', '✓'), h('span', '잡아 둔 주간 목표를 모두 채웠습니다.'))
              : null,
            acc.enough && acc.median_ratio > 1.4
              ? h('div.hint', { style: { background: 'color-mix(in srgb, var(--warn) 11%, transparent)' } },
                  h('span.icon', '!'),
                  h('span', `추정이 실제보다 중앙값 ${acc.median_ratio}배 짧았습니다. 다음 주 추정에는 ${Math.round((acc.median_ratio - 1) * 100)}% 를 미리 얹으세요.`))
              : null,
            rhythm?.enough && rhythm.best_window
              ? h('div.hint', h('span.icon', '◎'),
                  h('span',
                    `당신의 골든타임은 ${String(rhythm.best_window.start_hour).padStart(2, '0')}시–${String(rhythm.best_window.end_hour).padStart(2, '0')}시입니다. `,
                    '다음 주 달력에서 이 시간대부터 비워 두고, 회의는 나머지로 미세요.'))
              : null,
            t.meeting_sec > t.deep_sec && t.meeting_sec > 3600
              ? h('div.hint', { style: { background: 'color-mix(in srgb, var(--warn) 11%, transparent)' } },
                  h('span.icon', '!'),
                  h('span', `회의(${dur(t.meeting_sec)})가 몰입(${dur(t.deep_sec)})보다 많았습니다. 다음 주 달력에 90분짜리 빈 블록을 먼저 잡아 두세요.`))
              : null,
        ),

        promiseBox,

        h('label.field', '다음 주에 지킬 것 하나', commitment,
          h('span', { style: { fontSize: '11px' } },
            '여러 개를 적으면 하나도 안 지켜집니다. 다음 주 월요일 노트에 자동으로 올라갑니다.')),
      ],
      footer: [
        h('button.btn', { onclick: close }, '닫기'),
        h('button.btn.primary', { onclick: submit }, '마무리'),
      ],
    };
  });
}
