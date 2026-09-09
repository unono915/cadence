import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * 가장 오래된 스키마에서 지금까지 **한 번에** 올라오는지 본다.
 *
 * 마이그레이션은 하나씩 보면 다 맞는데, 순서대로 이어 돌릴 때 어긋나는 일이 있다 —
 * 뒤 마이그레이션이 앞에서 만든 열을 쓰거나, 앞이 지운 행을 뒤가 다시 세거나.
 * 그리고 그 상황을 실제로 겪는 사람은 **오래 쓰다가 오랜만에 업데이트한 사람**,
 * 즉 잃을 기록이 가장 많은 사람이다.
 *
 * 그래서 첫 판(v1) 스키마로 DB 를 만들고 옛 판이 남기던 모양의 기록을 심은 뒤,
 * 자식 프로세스에서 열어 끝까지 올라오는지 확인한다. 각 마이그레이션이 주석에 적어 둔
 * 일을 실제로 했는지까지 본다 — "돌긴 돌았다" 로는 부족하다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const DB_MJS = path.join(ROOT, 'server', 'lib', 'db.mjs');

/**
 * 첫 판 스키마를 `db.mjs` 에서 그대로 꺼낸다.
 * 손으로 옮겨 적으면 그건 이미 v1 이 아니다 — 언젠가 원본만 바뀐다.
 */
function firstMigrationSql() {
  const src = fs.readFileSync(DB_MJS, 'utf8');
  const start = src.indexOf('const MIGRATIONS = [');
  assert.ok(start > 0, 'db.mjs 에서 MIGRATIONS 를 찾지 못했습니다');
  const rest = src.slice(src.indexOf('`', start) + 1);
  const sql = rest.slice(0, rest.indexOf('`'));
  assert.match(sql, /CREATE TABLE activity/, '첫 마이그레이션이 최초 스키마가 아닙니다');
  return sql;
}

test('첫 판 스키마에서 지금 판까지 한 번에 올라온다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-mig-'));
  try {
    // --- 1) v1 DB 를 만들고 옛 판이 남기던 모양의 기록을 심는다 ---
    const db = new DatabaseSync(path.join(dir, 'cadence.db'));
    db.exec(firstMigrationSql());
    db.exec('PRAGMA user_version = 1');
    db.exec(`INSERT INTO categories(id, name, kind, color, sort_order)
             VALUES (1, '개발', 'deep', '#4f9d69', 10), (2, '미분류', 'other', '#6b7280', 100)`);

    const t = Date.parse('2026-09-01T09:00:00');
    const ins = db.prepare(`INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-09-01')`);
    // 공백이 다듬어지지 않던 시절의 기록 (마이그레이션 8)
    ins.run('Code ', '  a.js\t보고서  ', 'code.exe', t, t + 600_000, 600, 0, 1);
    // 잠금 화면을 활동으로 세던 시절의 기록 (마이그레이션 6)
    ins.run('LockApp.exe', '잠금 화면', 'lockapp', t + 600_000, t + 1_200_000, 600, 0, 1);
    // 사람이 손으로 넣은 기록 (마이그레이션 7 이 고정 표시를 남겨야 한다)
    ins.run('회의', '팀 회의', 'manual', t + 1_200_000, t + 3_000_000, 1800, 0, 1);
    // 1분 만에 끝났는데 '완주' 로 남은 세션 (마이그레이션 9)
    db.prepare(`INSERT INTO focus_sessions(kind, planned_min, started_at, ended_at, status, note, day)
                VALUES ('focus', 25, ?, ?, 'done', '', '2026-09-01')`).run(t, t + 60_000);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.close();

    // --- 2) 자식 프로세스에서 열어 끝까지 올린다 ---
    // 이 검사 프로세스는 이미 다른 데이터 폴더로 db.mjs 를 불러왔으므로 따로 띄워야 한다.
    const probe = `
      import { db, all } from '${pathToFileURL(DB_MJS).href}';
      console.log(JSON.stringify({
        version: db.prepare('PRAGMA user_version').get().user_version,
        activity: all('SELECT id, app, title, idle, pinned, category_id FROM activity ORDER BY id'),
        sessions: all('SELECT status FROM focus_sessions'),
      }));
    `;
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
      cwd: ROOT,
      env: { ...process.env, CADENCE_DATA_DIR: dir, CADENCE_NO_TRACKER: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(res.status, 0, `마이그레이션이 실패했습니다: ${(res.stderr || '').slice(0, 400)}`);

    const out = JSON.parse(res.stdout.trim().split('\n').pop());
    const [code, lock, manual] = out.activity;

    assert.ok(out.version >= 9, `끝까지 올라오지 않았습니다 (user_version ${out.version})`);

    // 8 — 앞뒤 공백과 탭이 다듬어진다.
    assert.equal(code.app, 'Code');
    assert.equal(code.title, 'a.js 보고서');

    // 6 — 잠금 화면은 자리비움으로 돌아가고 분류가 비워진다.
    assert.equal(lock.app, '(자리비움)');
    assert.equal(lock.idle, 1);
    assert.equal(lock.category_id, null);

    // 7 — 손으로 넣은 기록에는 고정 표시가 남는다. 자동 기록에는 남지 않는다.
    assert.equal(manual.pinned, 1);
    assert.equal(code.pinned, 0);

    // 9 — 25분 중 1분짜리 '완주' 는 중단으로 다시 매겨진다.
    assert.deepEqual(out.sessions, [{ status: 'abandoned' }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
