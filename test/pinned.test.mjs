import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('pinned');
process.env.CADENCE_NO_TRACKER = '1';

const { run, get, all } = await import('../server/lib/db.mjs');
const { seedDefaults, recategorizeAll } = await import('../server/lib/categorize.mjs');
const activity = await import('../server/api/activity.mjs');

/**
 * 손으로 정한 분류는 규칙이 덮지 않는다.
 *
 * 규칙을 하나 만들 때마다 기존 기록을 다시 훑는데(`apply_existing`), 여기에 사용자가
 * 직접 고쳐 둔 분류까지 딸려 들어가고 있었다. "이 두 시간은 회의였다" 고 고쳐 놓아도
 * 그 다음에 아무 규칙이나 하나 만들면 조용히 미분류로 돌아갔다 — 화면에는 아무 말도 없이.
 *
 * 눈으로는 절대 못 잡는다. 고친 직후에는 맞게 보이고, 되돌아가는 것은 며칠 뒤 다른 화면에서다.
 */

seedDefaults();
const cat = Object.fromEntries(all('SELECT id, name FROM categories').map((r) => [r.name, r.id]));

function insertTracked(day, hour, app, title) {
  const from = at(day, hour);
  const to = from + 600_000;
  const res = run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES (?, ?, 'chrome.exe', ?, ?, 600, 0, ?, ?)`,
    app, title, from, to, cat['미분류'], day,
  );
  return { id: Number(res.lastInsertRowid), from, to };
}

const categoryOf = (id) => get('SELECT category_id FROM activity WHERE id = ?', id).category_id;
const pinnedOf = (id) => get('SELECT pinned FROM activity WHERE id = ?', id).pinned;

test('구간 지정으로 고친 분류는 재분류가 덮지 않는다', () => {
  const row = insertTracked('2026-03-02', 10, 'Google Chrome', '사내 위키 정리 - Chrome');

  const res = activity.assignRange({ from: row.from, to: row.to, category_id: cat['문서·작성'] });
  assert.equal(res.updated, 1);
  assert.equal(categoryOf(row.id), cat['문서·작성']);
  assert.equal(pinnedOf(row.id), 1, '구간 지정은 고정 표시를 남겨야 합니다');

  recategorizeAll();
  assert.equal(categoryOf(row.id), cat['문서·작성'],
    '규칙 재적용이 손으로 정한 분류를 되돌렸습니다');
});

test('낱개 기록을 고친 것도 재분류가 덮지 않는다', () => {
  const row = insertTracked('2026-03-02', 11, 'Google Chrome', '분기 계획 검토 - Chrome');

  activity.updateActivity(row.id, { category_id: cat['설계·리서치'] });
  assert.equal(pinnedOf(row.id), 1);

  recategorizeAll();
  assert.equal(categoryOf(row.id), cat['설계·리서치']);
});

test('카테고리를 비우면 다시 규칙에 맡긴다', () => {
  // 잘못 고정한 것을 풀 방법이 없으면, 한 번의 실수가 영원히 남는다.
  const row = insertTracked('2026-03-02', 12, 'Visual Studio Code', 'app.mjs');
  activity.updateActivity(row.id, { category_id: cat['휴식'] });
  assert.equal(pinnedOf(row.id), 1);

  activity.updateActivity(row.id, { category_id: null });
  assert.equal(pinnedOf(row.id), 0, '고정을 풀어야 합니다');

  recategorizeAll();
  assert.equal(categoryOf(row.id), cat['개발'], '규칙이 다시 분류해야 합니다');
});

test('수동 입력은 카테고리를 고른 경우에만 고정한다', () => {
  // 카테고리를 비워 두면 규칙이 정한 것이므로, 규칙이 좋아질 때 함께 좋아지는 편이 낫다.
  const chosen = activity.addManualActivity({
    started_at: at('2026-03-02', 14), minutes: 30,
    app: '오프라인', title: '팀 주간회의', category_id: cat['회의'],
  });
  assert.equal(chosen.pinned, 1);

  const derived = activity.addManualActivity({
    started_at: at('2026-03-02', 15), minutes: 30,
    app: 'Visual Studio Code', title: '리팩터링',
  });
  assert.equal(derived.pinned, 0);
  assert.equal(derived.category_id, cat['개발'], '규칙이 분류해야 합니다');

  recategorizeAll();
  assert.equal(categoryOf(chosen.id), cat['회의'], '고른 카테고리가 사라졌습니다');
});

test('고정되지 않은 기록은 규칙이 계속 정리한다', () => {
  // 고정 표시가 "아무것도 다시 분류하지 않는다" 로 번지면 규칙 기능 자체가 죽는다.
  const row = insertTracked('2026-03-02', 16, 'Google Chrome', '점심 뭐 먹지 - YouTube - Chrome');
  assert.equal(categoryOf(row.id), cat['미분류'], '넣을 때는 미분류였다');

  const changed = recategorizeAll();
  assert.ok(changed >= 1, `재분류가 아무것도 못 고쳤습니다 (${changed}건)`);
  assert.equal(categoryOf(row.id), cat['방해요소']);
});

test('규칙 학습("이 앱을 항상 이렇게")도 고정된 기록을 덮지 않는다', () => {
  // 이 길은 `recategorizeAll()` 을 거치지 않고 스스로 UPDATE 를 돌린다.
  // 한쪽에만 조건을 걸어 두면, 정작 사람들이 가장 많이 누르는 버튼에서 그대로 덮인다.
  const row = insertTracked('2026-03-03', 10, 'Google Chrome', '회의록 정리 - Chrome');
  activity.updateActivity(row.id, { category_id: cat['회의'] });

  const other = insertTracked('2026-03-03', 11, 'Google Chrome', '회의록 정리 - Chrome');

  const res = activity.teachRule({
    field: 'title', pattern: '회의록', category_id: cat['문서·작성'], apply_existing: true,
  });

  assert.equal(categoryOf(row.id), cat['회의'], '손으로 정한 분류가 규칙 학습에 덮였습니다');
  assert.equal(categoryOf(other.id), cat['문서·작성'], '고정되지 않은 쪽은 규칙을 따라야 합니다');
  assert.equal(res.updated, 1, '고정된 것까지 세면 "N건 정리했습니다" 가 거짓말이 된다');
});

test('자리비움을 "회의였다"로 정리한 것도 규칙이 덮지 않는다', () => {
  const from = at('2026-03-04', 9);
  const res = run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
     VALUES ('(자리비움)', '', '', ?, ?, 3600, 1, NULL, '2026-03-04')`,
    from, from + 3600_000,
  );
  const id = Number(res.lastInsertRowid);

  activity.resolveGap(id, { app: '오프라인', title: '팀 회의', category_id: cat['회의'] });
  assert.equal(pinnedOf(id), 1);

  recategorizeAll();
  assert.equal(categoryOf(id), cat['회의']);
});

test('카테고리를 지우면 그 카테고리로 고정해 둔 기록이 풀린다', () => {
  // 카테고리를 지우면 category_id 는 NULL 이 된다(ON DELETE SET NULL). 그런데 고정 표시가
  // 남으면 규칙도 "전체 다시 분류" 도 그 행을 건드리지 못한다 — 사람이 고른 카테고리는
  // 이미 없는데 그 자리만 영원히 비어 있게 된다. 어느 화면에도 이유가 나오지 않는다.
  const temp = activity.createCategory({ name: '임시분류', kind: 'shallow', color: '#888888' });
  const row = insertTracked('2026-03-05', 10, 'Visual Studio Code', 'app.mjs');
  activity.updateActivity(row.id, { category_id: temp.id });
  assert.equal(pinnedOf(row.id), 1);

  activity.deleteCategory(temp.id);
  assert.equal(pinnedOf(row.id), 0, '고정이 풀리지 않아 영원히 미분류로 남습니다');
  assert.equal(categoryOf(row.id), null);

  recategorizeAll();
  assert.equal(categoryOf(row.id), cat['개발'], '규칙이 다시 분류해야 합니다');
});

test('손으로 넣은 앱·제목도 자동 추적과 같은 규칙으로 다듬는다', () => {
  // 추적기는 보이지 않는 글자와 줄바꿈·탭을 걷어 내는데, 손으로 넣는 쪽은 trim 만 했다.
  // 그래서 붙여 넣기 한 번에 줄바꿈이 든 제목이 들어가고, 한 줄로 보여 주는 표에서 줄이
  // 깨지고 CSV 에도 그대로 실려 나갔다. 같은 칸이 들어온 길에 따라 다르게 다뤄지면,
  // 그 칸을 믿고 쓰는 코드가 전부 두 경우를 다 신경 써야 한다.
  const made = activity.addManualActivity({
    started_at: at('2026-03-06', 14), minutes: 30,
    app: '  회의실  A  ',
    title: '분기 계획\t검토\r\n2차​회',
  });
  assert.equal(made.app, '회의실 A');
  assert.equal(made.title, '분기 계획 검토 2차 회');

  // 자리비움 정리도 마찬가지다.
  const from = at('2026-03-06', 16);
  const gapId = Number(run(
    `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, day)
     VALUES ('(자리비움)', '', '', ?, ?, 3600, 1, '2026-03-06')`,
    from, from + 3600_000,
  ).lastInsertRowid);
  const fixed = activity.resolveGap(gapId, { app: ' 외근\t ', title: '고객사\n방문' });
  assert.equal(fixed.app, '외근');
  assert.equal(fixed.title, '고객사 방문');

  // 다듬고 나면 빈 값이 되는 앱 이름은 받지 않는다 — 이름 없는 기록은 목록에서 사라진다.
  assert.throws(
    () => activity.addManualActivity({ started_at: at('2026-03-06', 18), minutes: 10, app: '​​' }),
    /app/,
  );
});

test('백업이 고정 표시를 함께 나른다', async () => {
  // 표시가 백업에서 빠지면, 복원한 순간 손으로 정한 분류가 전부 규칙에 노출된다.
  const { BACKUP_TABLES } = await import('../server/api/backup.mjs');
  const cols = BACKUP_TABLES.find((t) => t.name === 'activity').columns;
  assert.ok(cols.includes('pinned'), `activity 백업 컬럼에 pinned 이 없습니다: ${cols.join(', ')}`);
});
