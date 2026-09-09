import { dur, pct, hhmm, josa } from './format.js';

/**
 * 하루 리포트를 읽고 사람이 바로 행동할 수 있는 문장으로 바꾼다.
 * 숫자를 다시 말해주는 것이 아니라 "그래서 뭘 하면 되는가"를 담는 것이 목적이라,
 * 각 항목은 관찰 → 근거 → 다음 행동의 순서로 쓴다.
 */
export function dayInsights(report, { rhythm = null, isToday = false } = {}) {
  const out = [];

  // 지금이 골든타임이면 그 사실이 다른 무엇보다 먼저다 — 지나가면 쓸모없는 정보라서.
  if (isToday && rhythm?.enough && rhythm.best_window) {
    const hour = new Date().getHours();
    const { start_hour: s, end_hour: e, deep_ratio: ratio } = rhythm.best_window;
    const label = `${String(s).padStart(2, '0')}시–${String(e).padStart(2, '0')}시`;
    if (hour >= s && hour < e) {
      out.push({
        kind: 'good',
        text: `지금은 당신의 골든타임(${label})입니다. 최근 ${rhythm.weeks}주 동안 이 시간대의 ${Math.round(ratio * 100)}%를 몰입으로 썼습니다 — 회의나 잡무를 끼워 넣지 마세요.`,
        action: 'focus',
      });
    } else if (hour < s && s - hour <= 2) {
      out.push({
        kind: 'info',
        text: `${label}가 당신의 골든타임입니다. 곧 시작되니 그 전에 알림을 정리하고 창을 하나로 줄여 두세요.`,
      });
    }
  }
  const active = report.active_sec;
  const deep = report.kinds.deep || 0;
  const targetSec = (report.targets?.deep_min || 180) * 60;

  if (active < 900) {
    out.push({
      kind: 'info',
      text: '오늘 기록이 거의 없습니다. 자동 추적이 켜져 있는지 확인하거나, 오프라인 작업은 타임라인에서 직접 추가할 수 있습니다.',
    });
    return out;
  }

  // 미분류가 많으면 아래의 모든 숫자가 실제보다 낮다.
  //
  // 미분류 시간은 몰입에도, 방해에도, 프로젝트 배분에도 들어가지 않는다. 그래서
  // "몰입이 부족합니다" 같은 말을 아무리 해 봐야 원인은 일하는 방식이 아니라 분류다.
  // 다른 무엇을 말하기 전에 이것부터 짚어야 나머지 조언이 거짓말이 되지 않는다.
  const unclassified = report.kinds.other || 0;
  if (unclassified >= active * 0.35 && unclassified >= 1800) {
    out.push({
      kind: 'warn',
      text: `오늘 활동의 ${pct(unclassified, active)}%(${dur(unclassified)})가 아직 분류되지 않았습니다. 이 시간은 몰입에도 방해에도 들어가지 않아 아래 숫자와 점수가 모두 실제보다 낮게 나옵니다 — 타임라인의 '분류가 필요한 앱'에서 큰 것부터 정리해 보세요.`,
      action: 'classify',
    });
  }

  // 오늘 계획이 남은 시간에 들어가는지. 오늘 안에 고칠 수 있는 이야기라 위쪽에 둔다.
  if (isToday) {
    const fit = planFeasibilityText(planFeasibility(report));
    if (fit && fit.kind !== 'good') out.push(fit);
  }

  // 자기 자신과의 비교가 목표치보다 먼저다 — 사람마다 하루의 모양이 다르므로.
  const base = report.baseline;
  if (base?.enough) {
    const diff = deep - base.deep_sec;
    if (diff <= -3600) {
      out.push({
        kind: 'warn',
        text: `몰입 시간이 평소(최근 ${base.days}일 중앙값 ${dur(base.deep_sec)})보다 ${dur(-diff)} 적습니다. 오늘 무엇이 달랐는지 타임라인에서 확인해 보세요 — 회의가 많았는지, 잘게 끊겼는지.`,
      });
    } else if (diff >= 3600) {
      out.push({
        kind: 'good',
        text: `몰입 시간이 평소보다 ${dur(diff)} 많습니다 (중앙값 ${dur(base.deep_sec)}). 오늘 잘 통한 방식이 있었다면 메모에 남겨 두세요.`,
      });
    }
    const meetingDiff = (report.kinds.meeting || 0) - base.meeting_sec;
    if (meetingDiff >= 5400) {
      out.push({
        kind: 'info',
        text: `회의가 평소보다 ${dur(meetingDiff)} 많았습니다. 몰입 시간이 줄었다면 그 탓일 가능성이 큽니다.`,
      });
    }
  }

  // 목표가 그 사람의 일에 맞는지.
  //
  // 기본 목표는 하루 3시간 몰입이다 — 책상 앞이 일터인 사람을 전제한 값이다.
  // 수업이 하루 대부분인 교사, 현장을 도는 사람에게는 컴퓨터 앞이 하루 한 시간일 수 있다.
  // 그런 사람에게 매일 "목표의 20% 입니다" 라고 말하면, 도구가 알려 주는 것은
  // 일하는 방식이 아니라 목표가 틀렸다는 사실뿐이다. 그걸 대신 말해 준다.
  //
  // 며칠치 중앙값이 쌓인 뒤에만 꺼낸다. 하루 이틀 적었다고 목표를 낮추라고 하면
  // 그건 그냥 기준을 무너뜨리는 것이다.
  const targetMismatch = base?.enough && base.deep_sec > 0 && base.deep_sec < targetSec * 0.5;
  if (targetMismatch) {
    const suggested = Math.max(30, Math.round(base.deep_sec / 60 / 15) * 15);
    out.push({
      kind: 'info',
      text: `평소 몰입이 최근 ${base.days}일 중앙값 ${dur(base.deep_sec)}인데 목표는 ${dur(targetSec)}입니다. 이대로면 매일 '목표 미달'로 보여 숫자가 아무 말도 해 주지 못합니다 — 컴퓨터 밖에서 하는 일이 많다면 목표를 ${suggested}분쯤으로 낮춰 두는 편이 정확합니다.`,
      action: 'settings',
    });
  }

  // 몰입
  if (deep < targetSec * 0.35 && !targetMismatch) {
    const deepText = dur(deep);
    out.push({
      kind: 'warn',
      text: `몰입 시간이 ${deepText}${josa(deepText, '으로/로')} 목표(${dur(targetSec)})의 ${pct(deep, targetSec)}% 입니다. 지금 ${report.targets.focus_min}분짜리 집중 세션 하나를 시작하는 것이 가장 빠른 회복입니다.`,
      action: 'focus',
    });
  } else if (deep >= targetSec) {
    out.push({ kind: 'good', text: `몰입 ${dur(deep)} — 오늘 목표를 넘겼습니다. 남은 시간은 정리·소통에 써도 괜찮습니다.` });
  }

  // 연속성
  if (deep > 1800 && report.deep_blocks.length === 0) {
    out.push({
      kind: 'warn',
      text: `몰입한 시간은 ${dur(deep)} 있지만 ${report.targets.block_min}분 이상 끊기지 않은 구간이 하나도 없습니다. 시간이 아니라 연속성이 문제입니다 — 알림을 끄고 한 창만 띄운 채 한 블록을 만들어 보세요.`,
    });
  } else if (report.longest_block_sec >= 3600) {
    const longest = report.deep_blocks.reduce((best, b) => (b.deep_sec > (best?.deep_sec ?? 0) ? b : best), null);
    out.push({
      kind: 'good',
      text: `가장 긴 몰입 블록이 ${dur(report.longest_block_sec)}입니다. 이 시간대(${hhmm(longest?.start)} 무렵)가 당신의 골든타임일 가능성이 높습니다.`,
    });
  }

  // 파편화
  //
  // 두 시간은 앉아 있어야 이 이야기를 꺼낸다. 시간당 전환 횟수는 활동 시간으로 나눈 값이라,
  // 컴퓨터 앞에 잠깐씩만 앉은 날에는 분모가 작아 쉽게 커진다 — 수업 사이에 5분씩 여덟 번
  // 들른 교사는 전환이 잦을 수밖에 없고, 그건 습관이 아니라 그날의 일정이다.
  // 그런 사람에게 "메신저를 정해진 시각에만 여세요" 라고 하면 조언이 아니라 소음이다.
  // 숫자 자체는 화면에 그대로 둔다 — 재는 것과 훈수를 두는 것은 다른 일이다.
  if (report.switches_per_hour > 22 && active >= 2 * 3600) {
    out.push({
      kind: 'warn',
      text: `시간당 앱 전환이 ${report.switches_per_hour}회입니다. 전환 한 번마다 다시 몰입하는 데 수 분이 듭니다. 메신저·메일을 정해진 시각에만 여는 규칙을 시험해 보세요.`,
    });
  }

  // 방해요소
  const distraction = report.kinds.distraction || 0;
  if (distraction > 0 && distraction / active > 0.12) {
    out.push({
      kind: 'warn',
      text: `업무와 무관한 시간이 ${dur(distraction)}(활동의 ${pct(distraction, active)}%)입니다. 타임라인에서 어느 시간대에 몰렸는지 확인해 보세요.`,
    });
  }

  // 회의
  const meeting = report.kinds.meeting || 0;
  if (meeting > 3 * 3600) {
    out.push({
      kind: 'warn',
      text: `회의에 ${dur(meeting)}${josa(dur(meeting), '을/를')} 썼습니다. 남은 실작업 시간은 ${dur(Math.max(0, active - meeting))}뿐입니다 — 내일 일정에 최소 90분짜리 빈 블록 하나를 먼저 잡아두세요.`,
    });
  }

  // 세션 이행
  const f = report.focus;
  if (f.started >= 3 && f.abandoned > f.completed) {
    out.push({
      kind: 'warn',
      text: `집중 세션 ${f.started}회 중 ${f.abandoned}회를 중단했습니다. 세션 길이를 15분으로 줄이면 완주율이 올라가는 경우가 많습니다.`,
    });
  }
  if (f.completed >= 4 && f.interruptions === 0) {
    out.push({ kind: 'good', text: `세션 ${f.completed}회를 방해 없이 완주했습니다.` });
  }

  // 총량
  if (active > 9.5 * 3600) {
    out.push({
      kind: 'warn',
      text: `활동 시간이 ${dur(active)}입니다. 길게 앉아 있는 것과 많이 해내는 것은 다릅니다 — 내일은 총량을 줄이고 몰입 블록 수를 늘리는 쪽으로 잡아 보세요.`,
    });
  }

  // 태스크
  if (report.tasks.overdue > 0) {
    out.push({
      kind: 'warn',
      text: `기한이 지난 태스크가 ${report.tasks.overdue}개 있습니다. 다시 할 것인지, 날짜를 옮길 것인지, 버릴 것인지 지금 정하는 편이 낫습니다.`,
      action: 'tasks',
    });
  }
  if (report.tasks.completed >= 3) {
    out.push({ kind: 'good', text: `오늘 태스크 ${report.tasks.completed}개를 끝냈습니다.` });
  }

  return out.slice(0, 5);
}

/** 주간 리포트용 인사이트. */
export function weekInsights(week, trend) {
  const out = [];
  const t = week.totals;
  const workdays = week.daily.filter((d) => d.active_sec > 1800).length;

  if (workdays >= 2) {
    const avgDeep = t.deep_sec / workdays;
    out.push({
      kind: 'info',
      text: `기록된 ${workdays}일 기준 하루 평균 몰입 ${dur(avgDeep)}, 몰입 블록 ${dur(t.block_sec / workdays)}입니다.`,
    });
  }

  const best = [...week.daily].sort((a, b) => b.block_sec - a.block_sec)[0];
  if (best && best.block_sec > 0) {
    out.push({ kind: 'good', text: `이번 주 가장 좋았던 날은 ${best.day} — 몰입 블록 ${dur(best.block_sec)}.` });
  }

  const acc = week.estimate_accuracy;
  // 기준(표본 3개)은 서버가 `enough` 로 알려 준다 — 화면마다 숫자를 다시 적으면 갈라진다.
  if (acc.enough && acc.median_ratio) {
    if (acc.median_ratio > 1.4) {
      out.push({
        kind: 'warn',
        text: `완료한 일이 예상보다 중앙값 기준 ${acc.median_ratio}배 오래 걸렸습니다. 다음 추정에는 ${Math.round((acc.median_ratio - 1) * 100)}% 를 더해 잡으면 계획이 맞기 시작합니다.`,
      });
    } else if (acc.median_ratio < 0.7) {
      out.push({ kind: 'info', text: `추정을 실제보다 여유 있게 잡고 있습니다 (중앙값 ${acc.median_ratio}배). 더 촘촘히 계획해도 됩니다.` });
    } else {
      out.push({ kind: 'good', text: `추정 정확도가 좋습니다 (중앙값 ${acc.median_ratio}배).` });
    }
  }

  if (trend?.length >= 6) {
    const half = Math.floor(trend.length / 2);
    const older = trend.slice(0, half).reduce((s, d) => s + d.deep_sec, 0) / half;
    const newer = trend.slice(half).reduce((s, d) => s + d.deep_sec, 0) / (trend.length - half);
    if (older > 0) {
      const change = Math.round(((newer - older) / older) * 100);
      if (Math.abs(change) >= 15) {
        out.push({
          kind: change > 0 ? 'good' : 'warn',
          text: `최근 몰입 시간이 이전 구간 대비 ${change > 0 ? '+' : ''}${change}% 변했습니다 (하루 평균 ${dur(older)} → ${dur(newer)}).`,
        });
      }
    }
  }

  if (t.meeting_sec > t.deep_sec && t.meeting_sec > 3600) {
    out.push({
      kind: 'warn',
      text: `이번 주 회의(${dur(t.meeting_sec)})가 몰입 시간(${dur(t.deep_sec)})보다 많습니다.`,
    });
  }

  return out.slice(0, 6);
}

/**
 * 집중 세션 중 이탈 판정.
 *
 * "지금 딴 데로 새고 있다"는 사실은 하루가 끝난 뒤가 아니라 그 순간에 알려야 쓸모가 있다.
 * 다만 잔소리가 되면 사람들은 알림부터 끄므로, 말을 걸 조건을 아주 좁게 잡는다.
 *  - 집중 세션이 돌고 있을 때만. 휴식 중에는 무엇을 보든 상관없다.
 *  - 지금 창이 '방해요소' 로 분류돼 있을 때만. 분류가 안 된 앱은 건드리지 않는다.
 *  - 세션이 시작된 뒤로 머문 시간만 센다. 세션 전부터 열어 두고 있던 것은 이탈이 아니다.
 *  - 자리를 비운 것은 이탈이 아니다 — 그건 자리비움으로 따로 다룬다.
 *
 * 화면 쪽은 여기서 나온 결과를 그리기만 한다. 판단을 순수 함수로 떼어 두면
 * 브라우저를 띄우지 않고도 "언제 말을 거는가"를 고정해 둘 수 있다.
 *
 * @returns {{seconds:number, category:{name:string}, where:string}|null}
 */
export function driftAlert({ session, current, thresholdS, now = Date.now() }) {
  if (!thresholdS || thresholdS <= 0) return null;
  if (!session || session.kind !== 'focus') return null;
  if (!current || current.idle) return null;
  if (current.category?.kind !== 'distraction') return null;

  const since = Math.max(current.startedAt, session.started_at);
  const seconds = Math.round((now - since) / 1000);
  if (seconds < thresholdS) return null;

  const where = current.title ? `${current.app} — ${current.title}` : current.app;
  return { seconds, category: current.category, where: where.slice(0, 80) };
}

/**
 * 오늘 계획이 남은 시간 안에 들어가는가.
 *
 * 하루 마무리에서 "계획 3개 중 1개 완료" 를 보는 것은 이미 늦다 — 그때는 고칠 수 없다.
 * 오후 2시에 "지금 속도로는 안 됩니다" 를 알아야 하나를 내일로 넘기든 범위를 줄이든 한다.
 *
 * 두 가지를 곱해서 본다.
 *  - **추정 편향**: 사람은 대개 자기 일을 적게 잡고, 그 버릇은 개인마다 꽤 일정하다.
 *    최근 완료한 태스크의 실제/예상 중앙값을 곱해 "정직한 남은 시간"으로 바꾼다.
 *  - **남은 몰입 여력**: 목표치가 아니라 **평소의 자기 자신**을 기준으로 삼는다.
 *    평소 하루 몰입 중앙값에서 오늘 이미 한 만큼을 뺀 것이 오늘 더 할 수 있는 양이다.
 *
 * 기록이 얕을 때(추정 표본 3개 미만, 기준선 없음)는 아무 말도 하지 않는다 —
 * 근거 없는 예측은 신뢰만 깎는다.
 */
export function planFeasibility(report) {
  const planned = report.tasks?.planned_tasks || [];
  const remaining = planned.filter((t) => t.status !== 'done' && t.estimate_min > 0);
  if (!remaining.length) return null;

  const base = report.baseline;
  if (!base?.enough || !base.deep_sec) return null;

  const bias = report.estimate_bias;
  const ratio = bias?.median_ratio > 0 ? bias.median_ratio : 1;

  const estimateSec = remaining.reduce((s, t) => s + t.estimate_min * 60, 0);
  const honestSec = Math.round(estimateSec * ratio);
  const doneSec = report.kinds.deep || 0;
  const capacitySec = Math.max(0, base.deep_sec - doneSec);

  // 여유가 10% 미만이면 '빠듯', 여력을 넘기면 '초과'.
  const verdict = honestSec > capacitySec ? 'over'
    : honestSec > capacitySec * 0.9 ? 'tight'
      : 'ok';

  return {
    tasks: remaining.length,
    estimate_sec: estimateSec,
    honest_sec: honestSec,
    capacity_sec: capacitySec,
    over_sec: Math.max(0, honestSec - capacitySec),
    ratio,
    biased: ratio !== 1,
    verdict,
  };
}

/** 계획 진단을 사람이 읽는 한 문장으로. */
export function planFeasibilityText(fit) {
  if (!fit) return null;
  const honest = dur(fit.honest_sec);
  const capacity = dur(fit.capacity_sec);
  const basis = fit.biased
    ? `남은 계획 ${fit.tasks}건의 예상은 ${dur(fit.estimate_sec)}이지만, 당신의 최근 추정은 실제의 ${fit.ratio}배였습니다 — 실제로는 ${honest}쯤입니다.`
    : `남은 계획 ${fit.tasks}건에 ${honest}이 필요합니다.`;

  if (fit.verdict === 'over') {
    return {
      kind: 'warn',
      text: `${basis} 평소 하루 몰입량을 보면 오늘 남은 여력은 ${capacity} 정도라 ${dur(fit.over_sec)} 모자랍니다. 하나를 내일로 넘기거나 범위를 줄이는 편이 낫습니다 — 지금이면 아직 고를 수 있습니다.`,
      action: 'tasks',
    };
  }
  if (fit.verdict === 'tight') {
    return {
      kind: 'info',
      text: `${basis} 오늘 남은 여력이 ${capacity} 정도라 빠듯합니다. 회의나 잡무가 하나만 끼어도 넘칩니다.`,
    };
  }
  return {
    kind: 'good',
    text: `${basis} 오늘 남은 여력 ${capacity} 안에 들어갑니다.`,
  };
}

/**
 * "지금 무엇을 시작할까".
 *
 * 이 도구가 아는 것을 합치면 그 답을 낼 수 있다 — 오늘 하기로 한 일이 무엇이고,
 * 그중 무엇이 남았고, 지금이 이 사람의 몰입이 잘 되는 시간대인지.
 * 여태 이 도구는 "무엇이 있었는지"만 말했다. 아침에 화면을 열었을 때 필요한 것은
 * 요약이 아니라 **다음 한 걸음**이다.
 *
 * 규칙은 하나다: **무거운 일을 가장 좋은 시간에 둔다.**
 * 골든타임에 잡무를 하고 오후에 설계를 붙잡는 것이 하루가 무너지는 흔한 방식이라서.
 *
 * 근거가 없으면(리듬 표본 부족) 시간대 이야기는 빼고 우선순위만 본다 —
 * 없는 근거를 지어내면 나머지 조언까지 믿을 수 없게 된다.
 */
export function nextMove({ report, rhythm = null, now = Date.now() }) {
  const remaining = (report.tasks?.planned_tasks || []).filter((t) => t.status !== 'done');
  if (!remaining.length) return null;

  const weight = (t) => (t.estimate_min || 0);
  const priority = (t) => (t.importance ?? 1) * 2 + (t.urgency ?? 1);
  const hour = new Date(now).getHours();
  const window = rhythm?.enough ? rhythm.best_window : null;

  if (window && hour >= window.start_hour && hour < window.end_hour) {
    const pick = [...remaining].sort((a, b) => weight(b) - weight(a) || priority(b) - priority(a))[0];
    return {
      task: pick,
      when: 'golden',
      reason: `지금은 당신의 몰입이 가장 잘 되는 시간대(${hh(window.start_hour)}–${hh(window.end_hour)})입니다.`
        + ' 남은 것 중 가장 무거운 일을 여기에 두세요 — 이 시간에 잡무를 하면 그 일은 오후로 밀립니다.',
    };
  }

  if (window && hour < window.start_hour && window.start_hour - hour <= 2) {
    const pick = [...remaining].sort((a, b) => (weight(a) || Infinity) - (weight(b) || Infinity))[0];
    return {
      task: pick,
      when: 'before-golden',
      reason: `골든타임(${hh(window.start_hour)}–${hh(window.end_hour)})이 곧 시작됩니다.`
        + ' 그 전에 짧은 것부터 치워 두면 그 시간을 통째로 쓸 수 있습니다.',
    };
  }

  const pick = [...remaining].sort((a, b) => priority(b) - priority(a) || weight(b) - weight(a))[0];
  return {
    task: pick,
    when: window ? 'off-peak' : 'unknown',
    reason: window
      ? '지금은 몰입이 잘 되는 시간대가 아닙니다. 무거운 일은 골든타임으로 미루고, 지금은 이것부터.'
      : '오늘 하기로 한 것 중 가장 중요한 일입니다. 기록이 더 쌓이면 시간대까지 함께 봅니다.',
  };
}

function hh(hour) {
  return `${String(hour).padStart(2, '0')}시`;
}

/**
 * 노트에서 "이번 주 약속" 한 줄과, 이미 되짚었는지를 뽑는다.
 *
 * 약속은 지난 리뷰가 이 주 월요일 노트에 적어 둔 것이다. 되짚은 답도 같은 노트에 남는다.
 * 노트는 사용자가 자유롭게 쓰는 칸이라 같은 낱말이 여러 번 나올 수 있으므로,
 * **가장 마지막에 적힌 약속**을 본다.
 *
 * 이미 답한 약속을 또 물으면 리뷰를 다시 열 때마다 같은 질문이 반복되고,
 * 노트에는 같은 줄이 쌓인다. 그래서 답이 있으면 묻지 않고 그 답을 보여 준다.
 */
const PROMISE_MARK = '이번 주 약속 —';
const ANSWER_MARK = '지난 약속 되짚기 —';

export function lastCommitment(noteBody) {
  const lines = String(noteBody || '').split('\n');
  const promiseLine = [...lines].reverse().find((l) => l.includes(PROMISE_MARK));
  if (!promiseLine) return null;

  const text = promiseLine.split(PROMISE_MARK)[1]?.trim();
  if (!text) return null;

  // 되짚기 줄에는 약속 원문이 따옴표로 함께 들어 있다 — 그것으로 짝을 맞춘다.
  const answerLine = [...lines].reverse()
    .find((l) => l.includes(ANSWER_MARK) && l.includes(text));
  const answer = answerLine
    ? answerLine.split(ANSWER_MARK)[1]?.split('(')[0]?.trim() || null
    : null;

  return { text, answer };
}
