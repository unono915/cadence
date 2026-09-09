import test from 'node:test';
import assert from 'node:assert/strict';

// insights.js / format.js 는 DOM 을 쓰지 않는 순수 모듈이라 노드에서 그대로 검증할 수 있다.
// 사용자에게 보이는 문장을 만드는 곳이므로, "언제 무엇을 말하는가"를 고정해 둔다.
const { dayInsights, weekInsights } = await import('../web/lib/insights.js');

const HOUR = 3600;

/** 최소한의 dayReport 모양. 필요한 값만 덮어쓴다. */
function report(overrides = {}) {
  return {
    day: '2026-06-10',
    active_sec: 6 * HOUR,
    idle_sec: 0,
    kinds: { deep: 3 * HOUR },
    by_category: [],
    top_apps: [],
    deep_blocks: [],
    deep_block_sec: 0,
    longest_block_sec: 0,
    switches: 40,
    switches_per_hour: 7,
    focus: { started: 3, completed: 3, abandoned: 0, interruptions: 0, total_sec: HOUR },
    tasks: { completed: 1, created: 1, open: 4, overdue: 0, completed_tasks: [] },
    targets: { deep_min: 180, focus_sessions: 6, block_min: 15, focus_min: 25 },
    baseline: { enough: false },
    ...overrides,
  };
}

test('기록이 거의 없는 날은 지표 해석 대신 안내만 한다', () => {
  const out = dayInsights(report({ active_sec: 300, kinds: {} }));
  assert.equal(out.length, 1);
  assert.match(out[0].text, /자동 추적/);
});

test('몰입이 목표에 크게 못 미치면 지금 할 행동을 제안한다', () => {
  const out = dayInsights(report({ kinds: { deep: 30 * 60 } }));
  const warn = out.find((i) => i.action === 'focus');
  assert.ok(warn, '집중 세션을 권하는 항목이 있어야 한다');
  assert.equal(warn.kind, 'warn');
});

test('평소보다 몰입이 크게 줄면 기준선과 함께 말해 준다', () => {
  const out = dayInsights(report({
    kinds: { deep: 1 * HOUR },
    baseline: { enough: true, days: 12, deep_sec: 4 * HOUR, meeting_sec: 0, distraction_sec: 0 },
  }));
  const line = out.find((i) => i.text.includes('평소'));
  assert.ok(line);
  assert.equal(line.kind, 'warn');
  assert.match(line.text, /12일/);
});

test('몰입 시간은 있는데 블록이 없으면 "연속성"을 짚는다', () => {
  const out = dayInsights(report({ kinds: { deep: 2 * HOUR }, deep_blocks: [] }));
  assert.ok(out.some((i) => i.text.includes('연속성')));
});

test('전환이 잦으면 파편화를 지적한다', () => {
  const calm = dayInsights(report({ switches_per_hour: 5 }));
  const busy = dayInsights(report({ switches_per_hour: 30 }));
  assert.equal(calm.some((i) => i.text.includes('앱 전환')), false);
  assert.ok(busy.some((i) => i.text.includes('앱 전환')));
});

test('지금이 골든타임이면 가장 먼저 알려 준다', () => {
  const hour = new Date().getHours();
  const rhythm = {
    enough: true,
    weeks: 8,
    best_window: { start_hour: hour, end_hour: hour + 2, deep_ratio: 0.82 },
  };
  const out = dayInsights(report(), { rhythm, isToday: true });
  assert.match(out[0].text, /골든타임/);
  assert.equal(out[0].action, 'focus');

  // 다른 날을 보고 있을 때는 지금 시각 이야기를 하지 않는다.
  const other = dayInsights(report(), { rhythm, isToday: false });
  assert.equal(other.some((i) => i.text.includes('골든타임')), false);

  // 표본이 모자라면 말하지 않는다.
  const thin = dayInsights(report(), { rhythm: { enough: false }, isToday: true });
  assert.equal(thin.some((i) => i.text.includes('골든타임')), false);
});

test('골든타임이 두 시간 안으로 다가오면 미리 알려 준다', () => {
  const hour = new Date().getHours();
  if (hour > 21) return; // 늦은 시각에는 검증할 창이 없다
  const rhythm = {
    enough: true, weeks: 8,
    best_window: { start_hour: hour + 2, end_hour: hour + 4, deep_ratio: 0.8 },
  };
  const out = dayInsights(report(), { rhythm, isToday: true });
  assert.ok(out.some((i) => i.kind === 'info' && i.text.includes('골든타임')));
});

test('한 번에 다섯 항목을 넘기지 않는다', () => {
  const out = dayInsights(report({
    kinds: { deep: 10 * 60, meeting: 4 * HOUR, distraction: 2 * HOUR },
    active_sec: 10 * HOUR,
    switches_per_hour: 40,
    focus: { started: 6, completed: 1, abandoned: 5, interruptions: 9, total_sec: HOUR },
    tasks: { completed: 0, created: 0, open: 9, overdue: 3, completed_tasks: [] },
    baseline: { enough: true, days: 10, deep_sec: 4 * HOUR, meeting_sec: 0, distraction_sec: 0 },
  }));
  assert.ok(out.length <= 5, `항목이 ${out.length}개 — 한 화면에 담기지 않는다`);
});

test('주간 인사이트는 추정이 어긋난 만큼 보정치를 제안한다', () => {
  const week = {
    days: ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'],
    daily: [{ day: '2026-06-08', active_sec: 6 * HOUR, deep_sec: 3 * HOUR, block_sec: 2 * HOUR, distraction_sec: 0, meeting_sec: 0 }],
    totals: { active_sec: 30 * HOUR, deep_sec: 15 * HOUR, block_sec: 10 * HOUR, distraction_sec: HOUR, meeting_sec: 2 * HOUR, tasks_done: 5 },
    by_project: [],
    estimate_accuracy: { samples: 4, enough: true, median_ratio: 1.8, items: [] },
  };
  const out = weekInsights(week, []);
  const acc = out.find((i) => i.text.includes('추정'));
  assert.ok(acc);
  assert.match(acc.text, /80%/, '1.8배면 80% 를 더하라고 해야 한다');
});

// --- 집중 세션 중 이탈 판정 ---

const { driftAlert } = await import('../web/lib/insights.js');

const NOW = new Date('2026-06-10T14:00:00').getTime();

function drift(overrides = {}) {
  const { session = {}, current = {}, ...rest } = overrides;
  return driftAlert({
    now: NOW,
    thresholdS: 120,
    session: session === null
      ? null
      : { kind: 'focus', started_at: NOW - 20 * 60_000, task_title: '보고서', ...session },
    current: current === null
      ? null
      : {
          app: 'Google Chrome',
          title: 'YouTube',
          idle: false,
          startedAt: NOW - 5 * 60_000,
          category: { id: 8, name: '방해요소', kind: 'distraction' },
          ...current,
        },
    ...rest,
  });
}

test('집중 세션 중 방해요소에 오래 머물면 알린다', () => {
  const hit = drift();
  assert.ok(hit, '알림이 나와야 합니다');
  assert.equal(hit.seconds, 300);
  assert.equal(hit.category.name, '방해요소');
  assert.equal(hit.where, 'Google Chrome — YouTube');
});

test('이탈 알림을 아껴야 하는 상황들', () => {
  assert.equal(drift({ thresholdS: 0 }), null, '0 이면 기능을 끈 것이다');
  assert.equal(drift({ session: { kind: 'break' } }), null, '휴식 중에는 말 걸지 않는다');
  assert.equal(drift({ session: null }), null, '세션이 없으면 이탈이랄 것도 없다');
  assert.equal(drift({ current: { idle: true } }), null, '자리비움은 이탈이 아니다');
  assert.equal(drift({ current: { category: null } }), null, '분류 안 된 앱은 건드리지 않는다');
  assert.equal(
    drift({ current: { category: { name: '개발', kind: 'deep' } } }), null,
    '몰입 카테고리는 당연히 아니다',
  );
  assert.equal(
    drift({ current: { startedAt: NOW - 60_000 } }), null,
    '기준 시간을 넘기기 전에는 조용하다',
  );
});

test('세션 시작 전부터 보고 있던 것은 그때부터 세지 않는다', () => {
  // 30분 전에 열어 둔 창, 세션은 1분 전에 시작 — 아직 이탈 1분이므로 말 걸지 않는다.
  assert.equal(
    drift({
      session: { started_at: NOW - 60_000 },
      current: { startedAt: NOW - 30 * 60_000 },
    }),
    null,
  );
  // 같은 창이라도 세션이 3분 전에 시작됐다면 이탈 3분이다.
  const hit = drift({
    session: { started_at: NOW - 180_000 },
    current: { startedAt: NOW - 30 * 60_000 },
  });
  assert.equal(hit?.seconds, 180);
});

test('창 제목이 없으면 앱 이름만 쓴다', () => {
  assert.equal(drift({ current: { title: '' } })?.where, 'Google Chrome');
});

test('미분류가 많으면 다른 어떤 조언보다 먼저 그것을 짚는다', () => {
  // 미분류 시간은 몰입에도 방해에도 안 들어간다. 이 상태에서 "몰입이 부족합니다" 는
  // 원인을 잘못 짚은 말이 된다 — 일하는 방식이 아니라 분류가 문제이기 때문.
  const out = dayInsights(report({
    active_sec: 6 * HOUR,
    kinds: { deep: 0.5 * HOUR, other: 5 * HOUR },
  }));
  const first = out[0];
  assert.match(first.text, /분류되지 않았습니다/);
  assert.equal(first.kind, 'warn');
  assert.equal(first.action, 'classify');
});

test('미분류가 적으면 그 이야기는 꺼내지 않는다', () => {
  const out = dayInsights(report({
    active_sec: 6 * HOUR,
    kinds: { deep: 3 * HOUR, other: 0.4 * HOUR },
  }));
  assert.equal(out.some((i) => /분류되지 않았습니다/.test(i.text)), false);

  // 비율이 높아도 절대 시간이 짧으면(20분) 굳이 말할 거리가 아니다.
  const tiny = dayInsights(report({
    active_sec: 1200,
    kinds: { deep: 0, other: 1200 },
  }));
  assert.equal(tiny.some((i) => /분류되지 않았습니다/.test(i.text)), false);
});

// --- 조사 고르기 ---

const { josa } = await import('../web/lib/format.js');

test('앞말의 받침에 따라 조사를 고른다', () => {
  assert.equal(josa('3분', '으로/로'), '으로');
  assert.equal(josa('30초', '으로/로'), '로');
  assert.equal(josa('2시간', '으로/로'), '으로');
  assert.equal(josa('2시간 15분', '을/를'), '을');
  assert.equal(josa('45초', '을/를'), '를');

  // ㄹ 받침은 '으로' 를 붙이지 않는다 — '서울로', '1분으로'.
  assert.equal(josa('서울', '으로/로'), '로');
  assert.equal(josa('서울', '은/는'), '은');

  // 숫자는 읽는 소리를 따른다.
  assert.equal(josa('7', '으로/로'), '로', '칠 — ㄹ 받침');
  assert.equal(josa('3', '으로/로'), '으로', '삼');
  assert.equal(josa('2', '은/는'), '는', '이');
  assert.equal(josa('6', '은/는'), '은', '육');
});

test('실제 문장에서 조사가 값에 따라 바뀐다', () => {
  const short = dayInsights(report({ active_sec: 4 * HOUR, kinds: { deep: 40 } }));
  const line = short.find((i) => /목표/.test(i.text));
  assert.match(line.text, /40초로 목표/);

  const longer = dayInsights(report({ active_sec: 4 * HOUR, kinds: { deep: 20 * 60 } }));
  assert.match(longer.find((i) => /목표/.test(i.text)).text, /20분으로 목표/);
});

// --- 오늘 계획이 남은 시간에 들어가는가 ---

const { planFeasibility, planFeasibilityText } = await import('../web/lib/insights.js');

function planned(mins, status = 'todo') {
  return mins.map((m, i) => ({ id: i + 1, title: `일 ${i + 1}`, estimate_min: m, status }));
}

function planReport(overrides = {}) {
  return report({
    kinds: { deep: 2 * HOUR },
    baseline: { enough: true, days: 12, deep_sec: 5 * HOUR, meeting_sec: 0, distraction_sec: 0 },
    estimate_bias: { samples: 6, median_ratio: 1.5, items: [] },
    tasks: {
      completed: 0, created: 0, open: 3, overdue: 0, completed_tasks: [],
      planned: 3, planned_done: 0, planned_min: 0,
      planned_tasks: planned([60, 60, 60]),
    },
    ...overrides,
  });
}

test('추정 편향을 곱해 남은 계획의 실제 시간을 낸다', () => {
  // 예상 3시간 × 편향 1.5 = 4시간 30분. 여력은 평소 5시간 − 오늘 2시간 = 3시간.
  const fit = planFeasibility(planReport());
  assert.equal(fit.estimate_sec, 3 * HOUR);
  assert.equal(fit.honest_sec, 4.5 * HOUR);
  assert.equal(fit.capacity_sec, 3 * HOUR);
  assert.equal(fit.over_sec, 1.5 * HOUR);
  assert.equal(fit.verdict, 'over');

  const line = planFeasibilityText(fit);
  assert.equal(line.kind, 'warn');
  assert.match(line.text, /1\.5배/);
  assert.match(line.text, /1시간 30분 모자랍니다/);
});

test('이미 끝낸 계획은 남은 시간에서 뺀다', () => {
  const rep = planReport({
    tasks: {
      completed: 2, created: 0, open: 1, overdue: 0, completed_tasks: [],
      planned: 3, planned_done: 2, planned_min: 0,
      planned_tasks: [...planned([60], 'done'), ...planned([60], 'done'), ...planned([60])],
    },
  });
  const fit = planFeasibility(rep);
  assert.equal(fit.tasks, 1);
  assert.equal(fit.honest_sec, 1.5 * HOUR);
  assert.equal(fit.verdict, 'ok');
});

test('근거가 얕으면 아무 말도 하지 않는다', () => {
  // 기준선이 없으면 '남은 여력'을 만들 수가 없다.
  assert.equal(planFeasibility(planReport({ baseline: { enough: false } })), null);
  // 계획이 없거나 추정을 안 적었으면 셀 것이 없다.
  assert.equal(planFeasibility(planReport({
    tasks: { ...planReport().tasks, planned_tasks: [] },
  })), null);
  assert.equal(planFeasibility(planReport({
    tasks: { ...planReport().tasks, planned_tasks: [{ id: 1, title: '일', estimate_min: null, status: 'todo' }] },
  })), null);

  // 표본이 적은 편향은 쓰지 않고, 예상 그대로 본다.
  // (기준은 서버가 지킨다 — 표본이 3개 미만이면 median_ratio 를 아예 내보내지 않는다.)
  const fit = planFeasibility(planReport({
    estimate_bias: { samples: 2, enough: false, median_ratio: null, items: [] },
  }));
  assert.equal(fit.ratio, 1);
  assert.equal(fit.biased, false);
  assert.equal(fit.honest_sec, 3 * HOUR);
});

test('여유가 있으면 읽을거리에 굳이 올리지 않는다', () => {
  const rep = planReport({
    kinds: { deep: 0 },
    tasks: { ...planReport().tasks, planned_tasks: planned([30]) },
  });
  assert.equal(planFeasibility(rep).verdict, 'ok');
  const out = dayInsights(rep, { isToday: true });
  assert.equal(out.some((i) => /남은 계획/.test(i.text)), false);

  // 반대로 모자라면 위쪽에 올린다.
  const tightOut = dayInsights(planReport(), { isToday: true });
  assert.ok(tightOut.findIndex((i) => /남은 계획/.test(i.text)) >= 0);
});

test('지난 날짜를 볼 때는 계획 진단을 하지 않는다', () => {
  const out = dayInsights(planReport(), { isToday: false });
  assert.equal(out.some((i) => /남은 계획/.test(i.text)), false);
});

// --- 문장이 깨지지 않는지 (성질 검사) ---

/** 재현 가능한 난수. 실패한 씨앗을 그대로 다시 돌릴 수 있어야 한다. */
function seeded(seed) {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

/** 서버가 실제로 돌려주는 모양의 무작위 하루 리포트. */
function randomReport(seed) {
  const r = seeded(seed);
  const activeSec = Math.floor(r() * 12 * HOUR);
  const deep = Math.floor(r() * activeSec);
  const hasBaseline = r() < 0.6;
  const hasPlan = r() < 0.5;
  const planned = hasPlan ? 1 + Math.floor(r() * 4) : 0;
  return {
    day: '2026-06-10',
    active_sec: activeSec,
    idle_sec: Math.floor(r() * 3 * HOUR),
    kinds: {
      deep,
      meeting: Math.floor(r() * (activeSec - deep + 1)),
      distraction: Math.floor(r() * (activeSec - deep + 1)),
      other: Math.floor(r() * (activeSec - deep + 1)),
    },
    by_category: [],
    top_apps: r() < 0.5 ? [] : [{ app: '앱', seconds: Math.floor(r() * activeSec) }],
    deep_blocks: r() < 0.4 ? [] : [{ start: Date.now(), deep_sec: Math.floor(r() * deep) }],
    longest_block_sec: Math.floor(r() * deep),
    switches: Math.floor(r() * 300),
    switches_per_hour: Number((r() * 60).toFixed(1)),
    focus: {
      started: Math.floor(r() * 8),
      completed: Math.floor(r() * 5),
      abandoned: Math.floor(r() * 5),
      interruptions: Math.floor(r() * 10),
      total_sec: Math.floor(r() * 4 * HOUR),
      completion_rate: r(),
    },
    tasks: {
      completed: Math.floor(r() * 6),
      created: Math.floor(r() * 5),
      open: Math.floor(r() * 12),
      overdue: Math.floor(r() * 3),
      completed_tasks: [],
      planned,
      planned_done: Math.floor(r() * (planned + 1)),
      planned_min: planned * 30,
      planned_tasks: Array.from({ length: planned }, (_, i) => ({
        id: i + 1,
        title: `일 ${i + 1}`,
        estimate_min: r() < 0.3 ? null : 15 + Math.floor(r() * 120),
        status: r() < 0.4 ? 'done' : 'todo',
      })),
    },
    baseline: hasBaseline
      ? {
          enough: true,
          days: 5 + Math.floor(r() * 10),
          deep_sec: Math.floor(r() * 8 * HOUR),
          meeting_sec: Math.floor(r() * 3 * HOUR),
          distraction_sec: Math.floor(r() * HOUR),
        }
      : { enough: false },
    estimate_bias: {
      samples: Math.floor(r() * 8),
      median_ratio: Number((0.3 + r() * 3).toFixed(2)),
      items: [],
    },
    targets: { deep_min: 180, focus_sessions: 6, block_min: 15, focus_min: 25 },
  };
}

/**
 * 읽을거리는 최대 다섯 줄만 남기고 자른다. 그래서 무작위로 돌리기만 하면 **뒤쪽 문장이
 * 한 번도 실행되지 않고** 지나갈 수 있다 — 실제로 처음 쓴 검사는 앱 전환 문장의 오타를
 * 잡지 못했다. 그래서 문장이 깨지지 않는지 보는 것과 별개로,
 * "모든 문장이 적어도 한 번은 나왔는가"를 함께 확인한다.
 */
const INSIGHT_MARKERS = [
  '분류되지 않았습니다',
  '평소(최근',
  '많습니다 (중앙값',
  '회의가 평소보다',
  '목표(',
  '끊기지 않은 구간이 하나도 없습니다',
  '가장 긴 몰입 블록이',
  '시간당 앱 전환이',
  '업무와 무관한 시간이',
  '회의에',
  '중단했습니다',
  '방해 없이 완주했습니다',
  '길게 앉아 있는 것과',
  '기한이 지난 태스크가',
  '개를 끝냈습니다',
  '남은 계획',
];

test('어떤 하루에도 읽을거리 문장이 깨지지 않는다', () => {
  // 문장은 템플릿으로 만든다. 값이 하나라도 비면 화면에 'undefined' 나 'NaN' 이 그대로 뜨는데,
  // 그런 문장은 도구 전체의 신뢰를 한 번에 무너뜨린다.
  const seen = new Set();

  for (let seed = 1; seed <= 600; seed++) {
    const report = randomReport(seed);
    for (const isToday of [true, false]) {
      const out = dayInsights(report, { isToday });
      assert.ok(Array.isArray(out) && out.length <= 5, `씨앗 ${seed}: 읽을거리 개수가 이상합니다`);
      for (const item of out) {
        assert.ok(['good', 'warn', 'info'].includes(item.kind), `씨앗 ${seed}: 알 수 없는 종류 ${item.kind}`);
        assert.equal(typeof item.text, 'string');
        assert.ok(item.text.length > 5, `씨앗 ${seed}: 문장이 너무 짧습니다`);
        assert.doesNotMatch(item.text, /undefined|NaN|Infinity|\?분|\?시간|\?초|\[object/,
          `씨앗 ${seed}: 문장이 깨졌습니다 — ${item.text}`);
        // 음수 시간이 문장에 나오면 계산 어딘가가 뒤집힌 것이다.
        assert.doesNotMatch(item.text, /-\d+(시간|분|초)/, `씨앗 ${seed}: 음수 시간 — ${item.text}`);

        for (const marker of INSIGHT_MARKERS) {
          if (item.text.includes(marker)) seen.add(marker);
        }
      }
    }
  }

  // 무작위만으로는 뒤쪽 문장이 다섯 줄 제한에 밀려 한 번도 안 나올 수 있다.
  // 그래서 "그 조건 하나만 걸린 조용한 하루" 를 따로 만들어 나머지를 채운다.
  for (const report of triggerReports()) {
    for (const item of dayInsights(report, { isToday: true })) {
      assert.doesNotMatch(item.text, /undefined|NaN|Infinity|\?분|\?시간|\?초|\[object/, `문장이 깨졌습니다 — ${item.text}`);
      for (const marker of INSIGHT_MARKERS) {
        if (item.text.includes(marker)) seen.add(marker);
      }
    }
  }

  const missed = INSIGHT_MARKERS.filter((m) => !seen.has(m));
  assert.deepEqual(missed, [],
    `한 번도 나오지 않은 문장이 있습니다 — 이 문장들은 검사되지 않은 셈입니다: ${missed.join(' | ')}`);
});

/**
 * 조건 하나만 걸리는 하루들.
 *
 * 바탕은 아무 읽을거리도 나오지 않는 "조용한 하루" 다. 여기에 조건을 하나씩만 얹으면
 * 그 문장이 반드시 다섯 줄 안에 들어온다 — 뒤쪽 문장까지 실제로 실행된다.
 */
function triggerReports() {
  const quiet = (overrides = {}) => report({
    active_sec: 6 * HOUR,
    kinds: { deep: 2 * HOUR },
    deep_blocks: [{ start: Date.now(), deep_sec: 2 * HOUR }],
    longest_block_sec: 0,
    switches_per_hour: 5,
    baseline: { enough: false },
    focus: { started: 0, completed: 0, abandoned: 0, interruptions: 0, total_sec: 0, completion_rate: 0 },
    tasks: {
      completed: 0, created: 0, open: 0, overdue: 0, completed_tasks: [],
      planned: 0, planned_done: 0, planned_min: 0, planned_tasks: [],
    },
    ...overrides,
  });

  const base = { enough: true, days: 12, deep_sec: 2 * HOUR, meeting_sec: 0, distraction_sec: 0 };

  return [
    // 미분류가 많은 날
    quiet({ kinds: { deep: 2 * HOUR, other: 3 * HOUR } }),
    // 평소보다 몰입이 많은 날
    quiet({ kinds: { deep: 4 * HOUR }, baseline: base, deep_blocks: [{ start: Date.now(), deep_sec: 4 * HOUR }] }),
    // 회의가 평소보다 많은 날
    quiet({ kinds: { deep: 2 * HOUR, meeting: 2 * HOUR }, baseline: base }),
    // 몰입은 있는데 블록이 하나도 없는 날
    quiet({ deep_blocks: [] }),
    // 아주 긴 블록이 있는 날
    quiet({ longest_block_sec: 2 * HOUR }),
    // 회의가 세 시간을 넘은 날
    quiet({ active_sec: 8 * HOUR, kinds: { deep: 2 * HOUR, meeting: 4 * HOUR } }),
    // 종일 앉아 있던 날
    quiet({ active_sec: 10 * HOUR }),
    // 오래 앉아 있었는데 앱 사이를 계속 오간 날
    // (활동이 두 시간에 못 미치면 이 문장은 나오지 않는다 — 그때의 전환율은
    //  습관이 아니라 그날 일정이 만든 값이라서)
    quiet({ active_sec: 6 * HOUR, switches: 300, switches_per_hour: 50 }),
    // 세션을 방해 없이 완주한 날
    quiet({ focus: { started: 5, completed: 5, abandoned: 0, interruptions: 0, total_sec: 2 * HOUR, completion_rate: 1 } }),
    // 태스크를 여럿 끝낸 날
    quiet({ tasks: { completed: 4, created: 0, open: 0, overdue: 0, completed_tasks: [], planned: 0, planned_done: 0, planned_min: 0, planned_tasks: [] } }),
  ];
}

test('계획 진단도 어떤 값에서든 말이 되는 결과를 낸다', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const fit = planFeasibility(randomReport(seed));
    if (!fit) continue;
    assert.ok(fit.tasks > 0, `씨앗 ${seed}: 남은 계획이 0인데 진단이 나왔습니다`);
    assert.ok(fit.honest_sec >= 0 && Number.isFinite(fit.honest_sec), `씨앗 ${seed}: honest_sec 가 이상합니다`);
    assert.ok(fit.capacity_sec >= 0, `씨앗 ${seed}: 남은 여력이 음수입니다`);
    assert.ok(fit.over_sec >= 0, `씨앗 ${seed}: 초과 시간이 음수입니다`);
    assert.ok(['ok', 'tight', 'over'].includes(fit.verdict));
    const line = planFeasibilityText(fit);
    assert.doesNotMatch(line.text, /undefined|NaN|Infinity|\?분/, `씨앗 ${seed}: ${line.text}`);
  }
});

const WEEK_MARKERS = [
  '기준 하루 평균 몰입',
  '가장 좋았던 날은',
  '오래 걸렸습니다',
  '여유 있게 잡고 있습니다',
  '추정 정확도가 좋습니다',
  '이전 구간 대비',
  '보다 많습니다.',
];

/** 주간 리포트 한 벌. 필요한 값만 덮어쓴다. */
function weekOf(overrides = {}) {
  const days = ['2026-06-08', '2026-06-09', '2026-06-10', '2026-06-11', '2026-06-12', '2026-06-13', '2026-06-14'];
  return {
    days,
    daily: days.map((day, i) => ({
      day,
      active_sec: i < 5 ? 6 * HOUR : 0,
      deep_sec: i < 5 ? 3 * HOUR : 0,
      block_sec: i < 5 ? (i + 1) * 1800 : 0,
      distraction_sec: 0,
      meeting_sec: 0,
    })),
    totals: {
      active_sec: 30 * HOUR, deep_sec: 15 * HOUR, block_sec: 10 * HOUR,
      distraction_sec: HOUR, meeting_sec: 2 * HOUR, tasks_done: 5,
    },
    by_project: [],
    estimate_accuracy: { samples: 0, enough: false, median_ratio: null, items: [] },
    ...overrides,
  };
}

test('주간 읽을거리도 모든 문장이 적어도 한 번은 나온다', () => {
  // 주간 쪽도 여섯 줄에서 자른다 — 하루 쪽에서 겪은 것과 같은 사각지대가 생긴다.
  const seen = new Set();
  const collect = (week, trend) => {
    for (const item of weekInsights(week, trend)) {
      assert.doesNotMatch(item.text, /undefined|NaN|Infinity|\?분|\?시간|\?초|\[object/, `문장이 깨졌습니다 — ${item.text}`);
      assert.ok(['good', 'warn', 'info'].includes(item.kind));
      for (const m of WEEK_MARKERS) if (item.text.includes(m)) seen.add(m);
    }
  };

  const trendUp = Array.from({ length: 8 }, (_, i) => ({ deep_sec: (i < 4 ? 2 : 4) * HOUR }));

  collect(weekOf(), []);
  collect(weekOf({ estimate_accuracy: { samples: 4, enough: true, median_ratio: 1.8, items: [] } }), []);
  collect(weekOf({ estimate_accuracy: { samples: 4, enough: true, median_ratio: 0.5, items: [] } }), []);
  collect(weekOf({ estimate_accuracy: { samples: 4, enough: true, median_ratio: 1.0, items: [] } }), []);
  collect(weekOf(), trendUp);
  collect(weekOf({
    totals: { ...weekOf().totals, deep_sec: HOUR, meeting_sec: 5 * HOUR },
  }), []);

  const missed = WEEK_MARKERS.filter((m) => !seen.has(m));
  assert.deepEqual(missed, [],
    `한 번도 나오지 않은 주간 문장: ${missed.join(' | ')}`);
});

test('기록이 없는 주에도 주간 읽을거리가 깨지지 않는다', () => {
  const empty = weekOf({
    daily: weekOf().days.map((day) => ({ day, active_sec: 0, deep_sec: 0, block_sec: 0, distraction_sec: 0, meeting_sec: 0 })),
    totals: { active_sec: 0, deep_sec: 0, block_sec: 0, distraction_sec: 0, meeting_sec: 0, tasks_done: 0 },
  });
  for (const item of weekInsights(empty, [])) {
    assert.doesNotMatch(item.text, /undefined|NaN|Infinity|\?분/, item.text);
  }
  // 아무 근거도 없을 때 억지로 말을 지어내지 않는다.
  assert.ok(weekInsights(empty, []).length <= 1);
});

// --- "지금 무엇을 시작할까" ---

const { nextMove } = await import('../web/lib/insights.js');

const RHYTHM = { enough: true, weeks: 8, best_window: { start_hour: 15, end_hour: 17, deep_ratio: 0.88 } };

function planFor(tasks) {
  return report({
    tasks: {
      completed: 0, created: 0, open: tasks.length, overdue: 0, completed_tasks: [],
      planned: tasks.length, planned_done: 0, planned_min: 0, planned_tasks: tasks,
    },
  });
}

const HEAVY = { id: 1, title: '설계 문서', estimate_min: 120, status: 'todo', importance: 2, urgency: 1 };
const LIGHT = { id: 2, title: '메일 회신', estimate_min: 15, status: 'todo', importance: 1, urgency: 2 };
const URGENT = { id: 3, title: '장애 대응', estimate_min: 30, status: 'todo', importance: 3, urgency: 3 };

const atHour = (h) => new Date('2026-06-10T00:00:00').setHours(h, 30);

test('골든타임에는 가장 무거운 일을 권한다', () => {
  // 골든타임에 잡무를 하고 오후에 설계를 붙잡는 것이 하루가 무너지는 흔한 방식이다.
  const move = nextMove({ report: planFor([LIGHT, HEAVY, URGENT]), rhythm: RHYTHM, now: atHour(16) });
  assert.equal(move.task.id, HEAVY.id, `무거운 일을 골라야 합니다 (${move.task.title})`);
  assert.equal(move.when, 'golden');
  assert.match(move.reason, /15시–17시/);
});

test('골든타임 직전에는 짧은 것부터 치우게 한다', () => {
  const move = nextMove({ report: planFor([LIGHT, HEAVY]), rhythm: RHYTHM, now: atHour(14) });
  assert.equal(move.task.id, LIGHT.id);
  assert.equal(move.when, 'before-golden');
  assert.match(move.reason, /곧 시작됩니다/);
});

test('몰입이 잘 되지 않는 시간대에는 우선순위로 고른다', () => {
  const move = nextMove({ report: planFor([LIGHT, HEAVY, URGENT]), rhythm: RHYTHM, now: atHour(10) });
  assert.equal(move.task.id, URGENT.id);
  assert.equal(move.when, 'off-peak');
});

test('리듬을 알 만큼 기록이 없으면 시간대 이야기를 지어내지 않는다', () => {
  const move = nextMove({ report: planFor([LIGHT, URGENT]), rhythm: { enough: false }, now: atHour(16) });
  assert.equal(move.when, 'unknown');
  assert.equal(move.task.id, URGENT.id);
  assert.doesNotMatch(move.reason, /골든타임|시간대\)/);
});

test('권할 것이 없으면 아무 말도 하지 않는다', () => {
  assert.equal(nextMove({ report: planFor([]), rhythm: RHYTHM, now: atHour(16) }), null);
  assert.equal(nextMove({
    report: planFor([{ ...HEAVY, status: 'done' }]), rhythm: RHYTHM, now: atHour(16),
  }), null, '다 끝냈으면 권할 것이 없다');
});

test('추정을 안 적은 일도 다룰 수 있다', () => {
  const noEstimate = { id: 9, title: '추정 없음', estimate_min: null, status: 'todo', importance: 1, urgency: 1 };
  for (const hour of [10, 14, 16]) {
    const move = nextMove({ report: planFor([noEstimate]), rhythm: RHYTHM, now: atHour(hour) });
    assert.equal(move.task.id, noEstimate.id, `${hour}시에서 고르지 못했습니다`);
    assert.doesNotMatch(move.reason, /undefined|NaN/);
  }
});

// --- 주간 약속 되짚기 ---

const { lastCommitment } = await import('../web/lib/insights.js');

test('노트에서 마지막 약속을 찾는다', () => {
  assert.equal(lastCommitment(''), null);
  assert.equal(lastCommitment(null), null);
  assert.equal(lastCommitment('- 09:00 오늘 회의 많음\n'), null);

  const one = lastCommitment('- 09:00 메모\n- 10:00 이번 주 약속 — 오전엔 메신저를 닫는다\n');
  assert.equal(one.text, '오전엔 메신저를 닫는다');
  assert.equal(one.answer, null, '아직 되짚지 않았다');

  // 노트는 사용자가 자유롭게 쓰는 칸이다 — 여러 번 적혔다면 마지막 것을 본다.
  const many = lastCommitment([
    '- 10:00 이번 주 약속 — 첫 번째',
    '- 11:00 딴 이야기',
    '- 12:00 이번 주 약속 — 두 번째',
  ].join('\n'));
  assert.equal(many.text, '두 번째');
});

test('이미 되짚은 약속은 다시 묻지 않는다', () => {
  // 리뷰를 다시 열 때마다 같은 질문이 반복되면, 노트에 같은 줄이 쌓인다.
  const body = [
    '- 10:00 이번 주 약속 — 오전엔 메신저를 닫는다',
    '- 18:00 지난 약속 되짚기 — 반쯤 지켰다 ("오전엔 메신저를 닫는다")',
  ].join('\n');
  const found = lastCommitment(body);
  assert.equal(found.text, '오전엔 메신저를 닫는다');
  assert.equal(found.answer, '반쯤 지켰다');
});

test('다른 약속에 달린 답을 잘못 가져오지 않는다', () => {
  // 답 줄에는 약속 원문이 함께 들어 있다 — 그것으로 짝을 맞춘다.
  const body = [
    '- 10:00 이번 주 약속 — 예전 약속',
    '- 18:00 지난 약속 되짚기 — 지켰다 ("예전 약속")',
    '- 19:00 이번 주 약속 — 새 약속',
  ].join('\n');
  const found = lastCommitment(body);
  assert.equal(found.text, '새 약속');
  assert.equal(found.answer, null, '새 약속은 아직 되짚지 않았습니다');
});

test('약속 줄이 비어 있으면 없는 것으로 본다', () => {
  assert.equal(lastCommitment('- 10:00 이번 주 약속 — '), null);
  assert.equal(lastCommitment('- 10:00 이번 주 약속 —'), null);
});

test('목표가 그 사람의 일에 안 맞으면 목표 쪽을 짚는다', () => {
  // 기본 목표는 하루 3시간 몰입 — 책상 앞이 일터인 사람을 전제한 값이다.
  // 수업이 하루 대부분인 교사에게 매일 "목표의 20% 입니다" 라고 말하면,
  // 도구가 알려 주는 것은 일하는 방식이 아니라 목표가 틀렸다는 사실뿐이다.
  const out = dayInsights(report({
    active_sec: 90 * 60,
    kinds: { deep: 40 * 60 },
    baseline: { enough: true, days: 12, deep_sec: 45 * 60, meeting_sec: 0, distraction_sec: 0 },
  }));

  const hint = out.find((i) => i.action === 'settings');
  assert.ok(hint, '목표를 짚는 항목이 있어야 한다');
  assert.match(hint.text, /목표를 45분쯤으로/, '중앙값에 맞춘 값을 제안해야 한다');

  // 같은 화면에서 "목표에 못 미칩니다" 를 함께 말하면 두 말이 서로 어긋난다.
  assert.equal(out.find((i) => i.action === 'focus' && /목표\(/.test(i.text)), undefined,
    '목표가 틀렸다고 해 놓고 그 목표로 다시 나무라면 안 된다');
});

test('며칠 적었다고 목표를 낮추라고 하지는 않는다', () => {
  // 표본이 없으면 그냥 "오늘 적었다" 일 뿐이다. 그때 기준을 무너뜨리면 도구가 아니라 변명이 된다.
  const noBaseline = dayInsights(report({ kinds: { deep: 20 * 60 }, baseline: { enough: false } }));
  assert.equal(noBaseline.find((i) => i.action === 'settings'), undefined);

  // 평소가 목표에 견줄 만하면 목표는 맞는 것이다 — 오늘이 나빴을 뿐.
  const normal = dayInsights(report({
    kinds: { deep: 20 * 60 },
    baseline: { enough: true, days: 10, deep_sec: 2.5 * HOUR, meeting_sec: 0, distraction_sec: 0 },
  }));
  assert.equal(normal.find((i) => i.action === 'settings'), undefined);
  assert.ok(normal.find((i) => i.action === 'focus'), '이때는 오늘을 짚어야 한다');
});

test('잠깐씩만 앉은 날에는 전환 횟수로 훈수를 두지 않는다', () => {
  // 시간당 전환은 활동 시간으로 나눈 값이라 분모가 작으면 쉽게 커진다.
  // 수업 사이에 5분씩 여덟 번 들른 교사는 전환이 잦을 수밖에 없고, 그건 습관이 아니라
  // 그날의 일정이다. 재는 것과 훈수를 두는 것은 다른 일이다.
  const short = dayInsights(report({
    active_sec: 70 * 60,
    kinds: { deep: 40 * 60 },
    switches: 70,
    switches_per_hour: 60,
  }));
  assert.equal(short.find((i) => /앱 전환이/.test(i.text)), undefined,
    '한 시간 남짓 앉은 날에 파편화를 나무랍니다');

  // 충분히 앉아 있었다면 같은 숫자가 실제 신호다.
  const full = dayInsights(report({
    active_sec: 7 * 3600,
    kinds: { deep: 3 * HOUR },
    switches: 420,
    switches_per_hour: 60,
  }));
  assert.ok(full.find((i) => /앱 전환이 60회/.test(i.text)), '오래 앉은 날에는 말해 줘야 한다');
});

test('날짜 차이는 달력으로 센다', async () => {
  // 밀리초 차이를 86,400,000 으로 나누면 "몇 번의 24시간" 이 나온다 — 그건 며칠 뒤가 아니다.
  // 이 계산이 마감 라벨과 "마지막 백업 N일 전" 두 군데에 쓰이므로 한 곳에 모아 두고 검사한다.
  const { dayDiff } = await import('../web/lib/format.js');
  const at = (x) => new Date(x).getTime();

  const cases = [
    ['2026-09-09T23:00:00', '2026-09-10T01:00:00', 1, '두 시간 뒤지만 날짜는 하루 뒤'],
    ['2026-09-09T01:00:00', '2026-09-09T23:00:00', 0, '스물두 시간 뒤지만 같은 날'],
    ['2026-09-09T18:00:00', '2026-09-12T18:00:00', 3, '사흘'],
    ['2026-09-10T09:00:00', '2026-09-09T18:00:00', -1, '어제는 음수'],
    ['2026-12-31T20:00:00', '2027-01-01T09:00:00', 1, '해를 넘겨도 하루'],
    ['2026-02-28T12:00:00', '2026-03-01T12:00:00', 1, '달을 넘겨도 하루'],
  ];
  const wrong = cases
    .filter(([a, b, want]) => dayDiff(at(a), at(b)) !== want)
    .map(([a, b, want, why]) => `${why}: ${dayDiff(at(a), at(b))} (기대 ${want})`);
  assert.deepEqual(wrong, [], `날짜 차이가 어긋납니다:\n  ${wrong.join('\n  ')}`);
});

/**
 * 마감 라벨은 **달력 날짜**로 센다.
 *
 * 예전에는 밀리초 차이를 86,400,000 으로 나눴다. 그건 "지금부터 몇 번의 24시간" 이지
 * "며칠 뒤" 가 아니다. 마감은 보통 저녁 6시로 잡히므로, **저녁이 되면 라벨이 하루씩
 * 당겨졌다** — 내일 마감인 일이 "오늘 마감" 으로, 3일 남은 일이 "2일 남음" 으로 보였다.
 * 하필 남은 일을 훑어보는 시간대다. 낮에 보면 멀쩡해서 눈으로는 잡히지 않는다.
 */
test('마감 라벨이 저녁에 하루씩 당겨지지 않는다', async () => {
  const { dueInfo } = await import('../web/lib/format.js');
  const RealDate = Date;
  const at = (s) => new RealDate(s).getTime();

  const withNow = (now, fn) => {
    globalThis.Date = new Proxy(RealDate, {
      construct(t, a) { return a.length ? new t(...a) : new t(now); },
      get(t, p) { return p === 'now' ? () => now : Reflect.get(t, p); },
    });
    try { return fn(); } finally { globalThis.Date = RealDate; }
  };

  const cases = [
    // [지금, 마감, 보여야 할 말]
    ['2026-09-09T09:00:00', '2026-09-09T18:00:00', '오늘 마감'],
    ['2026-09-09T19:00:00', '2026-09-10T18:00:00', '내일 마감'],  // 저녁에 봐도 내일은 내일
    ['2026-09-09T23:30:00', '2026-09-10T18:00:00', '내일 마감'],
    ['2026-09-09T09:00:00', '2026-09-10T18:00:00', '내일 마감'],
    ['2026-09-09T20:00:00', '2026-09-12T18:00:00', '3일 남음'],
    ['2026-09-09T09:00:00', '2026-09-12T18:00:00', '3일 남음'],
    ['2026-09-09T19:00:00', '2026-09-09T18:00:00', '기한 초과'],
    ['2026-09-09T09:00:00', '2026-09-30T18:00:00', '9/30'],
  ];

  const wrong = [];
  for (const [now, due, want] of cases) {
    const got = withNow(at(now), () => dueInfo(at(due)))?.text;
    if (got !== want) wrong.push(`${now.slice(11, 16)} 에 ${due.slice(5, 10)} 마감 → "${got}" (기대: "${want}")`);
  }
  assert.deepEqual(wrong, [], `마감 라벨이 어긋납니다:\n  ${wrong.join('\n  ')}`);

  // 마감이 없으면 아무 말도 하지 않는다.
  assert.equal(dueInfo(null), null);
  assert.equal(dueInfo(0), null);
});
