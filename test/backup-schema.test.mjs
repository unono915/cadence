import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempData } from './helpers.mjs';

useTempData('backup-schema');
const { db } = await import('../server/lib/db.mjs');
const { seedDefaults } = await import('../server/lib/categorize.mjs');
const { BACKUP_TABLES } = await import('../server/api/backup.mjs');

seedDefaults();

/**
 * 백업이 스키마의 모든 열을 담는지 검사한다.
 *
 * 마이그레이션으로 열이 늘어날 때 백업 목록을 같이 고치는 것을 잊기 쉽다.
 * 그러면 내보내기·가져오기가 조용히 성공하면서 그 열의 값만 사라진다 —
 * 사용자가 알아채는 시점은 이미 원본을 덮어쓴 뒤다.
 */
test('백업은 모든 테이블의 모든 열을 담는다', () => {
  const problems = [];
  for (const { name, columns } of BACKUP_TABLES) {
    const actual = db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
    assert.ok(actual.length, `${name} 테이블이 없습니다`);

    const missing = actual.filter((c) => !columns.includes(c));
    const extra = columns.filter((c) => !actual.includes(c));
    if (missing.length) problems.push(`${name}: 백업에서 빠진 열 → ${missing.join(', ')}`);
    if (extra.length) problems.push(`${name}: 스키마에 없는 열 → ${extra.join(', ')}`);
  }
  assert.equal(problems.length, 0, `\n  ${problems.join('\n  ')}`);
});

test('백업 목록이 실제 테이블을 모두 덮는다', () => {
  const inDb = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((r) => r.name);
  const listed = BACKUP_TABLES.map((t) => t.name);

  const missed = inDb.filter((t) => !listed.includes(t));
  assert.equal(missed.length, 0, `백업에 빠진 테이블: ${missed.join(', ')}`);
});

/**
 * 지난 판에서 만든 백업도 열려야 한다.
 *
 * 열을 하나 더하는 순간, 그 전에 만든 백업에는 그 칸이 없다. 없는 값을 NULL 로 넣으면
 * `NOT NULL` 열에서 제약 위반이 나고 **가져오기 전체가 실패**한다.
 * 실제로 `pinned` 열을 더하자마자 그 전 백업이 하나도 복원되지 않았다 —
 * 백업의 값어치는 "옛것도 열린다" 는 데 있으므로, 이건 백업이 조용히 망가진 것과 같다.
 *
 * 그래서 여기서는 **기본값이 있는 열을 전부 뺀** 백업을 만들어 넣어 본다.
 * 앞으로 어떤 열을 더하든, 기본값만 달아 두면 이 검사가 저절로 지켜 준다.
 */
test('기본값이 있는 열이 빠진 옛 백업도 복원된다', async () => {
  const { importBackup } = await import('../server/api/backup.mjs');

  const required = (table) => db.prepare(`PRAGMA table_info(${table})`).all()
    .filter((c) => c.pk || (c.notnull && c.dflt_value === null))
    .map((c) => c.name);

  // 각 테이블에서 "반드시 있어야 하는 칸" 만 채운 한 줄씩.
  const sample = {
    categories: { id: 1, name: '개발', kind: 'deep', color: '#4f9d69' },
    projects: { id: 1, name: '프로젝트', created_at: 1 },
    tasks: { id: 1, title: '태스크', created_at: 1, updated_at: 1 },
    rules: { id: 1, pattern: 'Code', category_id: 1, created_at: 1 },
    focus_sessions: { id: 1, started_at: 1, day: '2023-11-14' },
    activity: {
      id: 1, app: 'Code', started_at: 1, ended_at: 2, seconds: 1, day: '2023-11-14',
    },
    notes: { day: '2023-11-14', updated_at: 1 },
    settings: { key: 'x', value: '1' },
  };

  // 표본이 실제 필수 칸을 모두 담고 있는지 먼저 본다 — 담지 못하면 검사가 헛돈다.
  const gaps = [];
  for (const { name } of BACKUP_TABLES) {
    for (const col of required(name)) {
      if (!(col in sample[name])) gaps.push(`${name}.${col}`);
    }
  }
  assert.deepEqual(gaps, [], `표본에 필수 칸이 빠졌습니다: ${gaps.join(', ')}`);

  const payload = Object.fromEntries(BACKUP_TABLES.map((t) => [t.name, [sample[t.name]]]));
  const res = importBackup(payload, 'replace');
  for (const { name } of BACKUP_TABLES) {
    assert.equal(res.counts[name], 1, `${name} 이(가) 복원되지 않았습니다`);
  }

  // 빠진 칸은 스키마의 기본값으로 채워진다 — NULL 이 아니다.
  const row = db.prepare('SELECT pinned, reviewed, title, exe FROM activity WHERE id = 1').get();
  assert.equal(row.pinned, 0);
  assert.equal(row.reviewed, 0);
  assert.equal(row.title, '');
  assert.equal(row.exe, '');
});
