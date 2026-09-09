import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.mjs';

useTempData('defaults');
process.env.CADENCE_NO_TRACKER = '1';

const { all, get, run, setting, setSetting } = await import('../server/lib/db.mjs');
const {
  seedDefaults, upgradeDefaults, categorize, invalidateRules, DEFAULTS_VERSION,
} = await import('../server/lib/categorize.mjs');

/**
 * 기본 규칙은 이미 쓰고 있는 사람에게도 닿아야 한다.
 *
 * `seedDefaults()` 는 카테고리가 비어 있을 때만 돈다. 그래서 기본 규칙을 아무리 손봐도
 * 어제 설치한 사람에게는 영원히 닿지 않았다 — 개선이 새 사용자에게만 가는 구조였다.
 *
 * 그렇다고 매번 전부 다시 심으면 사용자가 **일부러 지운 규칙**이 되살아난다.
 * 그 둘을 가르는 것이 판 번호다. 여기서 검사하는 것은 그 경계다.
 */

const CAT = () => Object.fromEntries(all('SELECT id, name FROM categories').map((r) => [r.name, r.id]));

test('첫 실행은 전부 심고 지금 판을 적어 둔다', () => {
  assert.equal(seedDefaults(), true);
  assert.equal(Number(setting('rule_defaults_version')), DEFAULTS_VERSION);

  // 이어서 부르면 아무것도 하지 않는다.
  assert.equal(seedDefaults(), false);
  assert.deepEqual(upgradeDefaults(), {
    added: 0, from: DEFAULTS_VERSION, to: DEFAULTS_VERSION, recategorized: 0,
  });
});

/** 판 2 에서 들어온 규칙 몇 개 — 판 1 설치본을 흉내 낼 때 지워 둔다. */
const V2_SAMPLE = ['Google Docs', 'Google Sheets', '에듀파인', 'CoolMessenger', 'Antigravity'];

function pretendVersion1() {
  for (const p of V2_SAMPLE) run('DELETE FROM rules WHERE pattern = ?', p);
  setSetting('rule_defaults_version', 1);
  invalidateRules();
}

test('옛 판에 머물러 있으면 그 뒤에 더해진 규칙만 들어온다', () => {
  pretendVersion1();
  const before = all('SELECT field, pattern FROM rules').length;

  const res = upgradeDefaults();

  assert.equal(res.added, V2_SAMPLE.length,
    `지운 ${V2_SAMPLE.length}개만 돌아와야 하는데 ${res.added}개가 들어왔습니다`);
  assert.equal(res.from, 1);
  assert.equal(res.to, DEFAULTS_VERSION);
  assert.equal(all('SELECT id FROM rules').length, before + res.added);

  // 판 1 규칙이 두 벌이 되지 않았는지 — 중복은 조용히 우선순위를 뒤집는다.
  const seen = new Set();
  for (const r of all('SELECT field, pattern FROM rules')) {
    const key = `${r.field} ${r.pattern.toLowerCase()}`;
    assert.ok(!seen.has(key), `규칙이 두 번 들어갔습니다: ${key}`);
    seen.add(key);
  }
});

test('판 번호가 없는 옛 설치본은 판 1 로 본다', () => {
  // 판을 세기 전에 깔린 설치본에는 이 값이 없다. 그것을 0 으로 읽으면 판 1 규칙까지
  // 다시 후보가 되고, 사용자가 일부러 지웠던 것이 업그레이드 한 번에 되살아난다.
  run("DELETE FROM settings WHERE key = 'rule_defaults_version'");
  run("DELETE FROM rules WHERE pattern = 'Netflix'");   // 판 1 — 지운 채로 두어야 한다
  run("DELETE FROM rules WHERE pattern = 'Overleaf'");  // 판 2 — 돌아와야 한다
  invalidateRules();

  const res = upgradeDefaults();
  assert.equal(res.from, 1, '판 번호가 없으면 1 로 봐야 합니다');
  assert.equal(get("SELECT COUNT(*) AS n FROM rules WHERE pattern = 'Netflix'").n, 0,
    '판 1 에서 지운 규칙이 되살아났습니다');
  assert.equal(get("SELECT COUNT(*) AS n FROM rules WHERE pattern = 'Overleaf'").n, 1,
    '판 2 규칙이 들어오지 않았습니다');
});

test('사용자가 지운 규칙은 되살리지 않는다', () => {
  // 판을 다시 올려 둔 상태이므로, 지운 뒤 upgrade 를 불러도 그대로여야 한다.
  const target = get("SELECT id, pattern FROM rules WHERE field = 'title' AND pattern = 'YouTube'");
  assert.ok(target, '검사 대상 규칙이 없습니다');
  run('DELETE FROM rules WHERE id = ?', target.id);
  invalidateRules();

  const res = upgradeDefaults();
  assert.equal(res.added, 0);
  assert.equal(get("SELECT COUNT(*) AS n FROM rules WHERE pattern = 'YouTube'").n, 0,
    '일부러 지운 규칙이 되살아났습니다');
});

test('손으로 먼저 만든 같은 규칙을 덮지 않는다', () => {
  const cat = CAT();
  pretendVersion1();
  // 판 2 규칙 하나를 사용자가 직접, 다른 카테고리로 먼저 만들어 두었다고 하자.
  run(
    `INSERT INTO rules(field, pattern, is_regex, category_id, priority, created_at)
     VALUES ('title', 'Google Docs', 0, ?, 5, ?)`,
    cat['학습'], Date.now(),
  );

  const res = upgradeDefaults();
  const docs = all("SELECT category_id, priority FROM rules WHERE pattern = 'Google Docs'");
  assert.equal(docs.length, 1, '같은 패턴이 두 개가 되었습니다');
  assert.equal(docs[0].category_id, cat['학습'], '사용자가 정한 카테고리가 바뀌었습니다');
  assert.equal(docs[0].priority, 5, '사용자가 정한 우선순위가 바뀌었습니다');
  assert.ok(res.added >= 1, 'Google Sheets 는 다시 들어와야 합니다');
});

test('새 규칙은 과거 기록까지 정리한다', () => {
  // 규칙이 오늘부터만 먹히면, 같은 화면 안에서 어제와 오늘의 몰입 시간이 다른 뜻을 갖는다.
  const cat = CAT();
  const t = Date.now() - 86_400_000;
  run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('Whale', '2026 예산 - K-에듀파인 - Whale', 'whale.exe', ?, ?, 600, 0, ?, '2026-03-01')`,
    t, t + 600_000, cat['미분류'],
  );

  pretendVersion1();

  const res = upgradeDefaults();
  assert.ok(res.recategorized >= 1, `과거 기록을 다시 분류하지 않았습니다 (${res.recategorized}건)`);
  assert.equal(
    get("SELECT category_id FROM activity WHERE app = 'Whale'").category_id,
    cat['관리·잡무'],
  );
});

test('실제로 미분류로 남던 창 제목들이 분류된다', () => {
  // 하루를 켜 두고 남은 미분류 목록에서 그대로 가져온 것들이다.
  // 여기가 깨지면 "왜 대부분이 미분류지?" 로 돌아간 것이다.
  const cat = CAT();
  const cases = [
    ['Google Chrome', '(2기 원고) 제출 - Google Drive - Chrome', '문서·작성'],
    ['Google Chrome', '(1일차)강의원고.pptx - Google Slides - Chrome', '문서·작성'],
    ['Google Chrome', '사용자 목록 - 관리 콘솔 - Chrome', '관리·잡무'],
    ['Google Chrome', 'eshare 화면 공유 - Google 검색 - Chrome', '설계·리서치'],
    ['Whale', 'K-에듀파인_WebDRM[25h] - Whale', '관리·잡무'],
    ['Whale', '4세대 나이스 시스템 - Whale', '관리·잡무'],
    ['Whale', '업무포털 메인 - Whale', '관리·잡무'],
    ['CoolMessenger', '0개의 안읽은 메시지', '커뮤니케이션'],
    ['WXSClient MFC 응용 프로그램', '폴더 찾아보기', '관리·잡무'],
    ['Antigravity IDE', 'index.html - Antigravity IDE', '개발'],
  ];

  const wrong = [];
  for (const [app, title, want] of cases) {
    const got = categorize({ app, title });
    if (got !== cat[want]) {
      const name = all('SELECT id, name FROM categories').find((c) => c.id === got)?.name ?? '(없음)';
      wrong.push(`${app} / ${title} → ${name} (기대: ${want})`);
    }
  }
  assert.deepEqual(wrong, [], `분류가 어긋납니다:\n  ${wrong.join('\n  ')}`);
});

test('흔한 낱말에 걸리는 패턴을 넣지 않는다', () => {
  // 'Line' 은 Outline·Deadline 에, 'Mail' 은 Gmail 아닌 것에도 걸린다.
  // 틀리게 분류된 시간은 미분류와 달리 화면에 드러나지 않는다 — 그래서 더 나쁘다.
  const cat = CAT();
  const shouldStayOther = [
    ['Google Chrome', 'Outline 정리 - Chrome'],
    ['Google Chrome', 'Deadline 확인 - Chrome'],
    ['Google Chrome', 'Workflow 설계 - Chrome'],
    ['Google Chrome', '나이스한 아이디어 모음 - Chrome'],
  ];
  const wrong = shouldStayOther
    .filter(([app, title]) => categorize({ app, title }) !== cat['미분류'])
    .map(([app, title]) => `${app} / ${title}`);
  assert.deepEqual(wrong, [], `미분류로 남아야 할 것이 분류됐습니다: ${wrong.join(' | ')}`);
});
