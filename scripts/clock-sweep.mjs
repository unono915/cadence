/**
 * 검사를 하루 여러 시각에 돌려 본다.
 *
 * 이 도구가 다루는 것은 전부 시각이다 — 업무일은 04시에 시작하고, 하루는 그 경계로
 * 잘리고, 어제와 오늘은 자정이 아니라 그 선으로 갈린다. 그런데 검사는 대개
 * `Date.now()` 에서 몇 시간을 더하고 빼서 표본을 만든다. 그러면 **검사를 돌리는 시각**에
 * 따라 표본이 업무일 경계를 넘어가고, 새벽 1시에만 실패하는 검사가 생긴다.
 *
 * 실제로 그런 것이 셋 있었다. 자정을 넘겨 작업하다 처음 드러났고, 그때까지는
 * "가끔 실패한다" 조차 모르고 있었다. 그런 것은 우연히 만나기를 기다릴 일이 아니다.
 *
 * 하는 일은 하나다 — `Date.now()` 와 `new Date()` 를 몇 시간씩 옮겨 놓고 검사를 통째로
 * 돌린다. 시각이 실제로 흐르지는 않으므로 빠르고, 붙잡는 것은 "지금 몇 시냐에 따라
 * 달라지는 검사" 다.
 *
 *   node scripts/clock-sweep.mjs           # 0,1,2,…,22시 (기본)
 *   node scripts/clock-sweep.mjs 3 13      # 특정 시각만
 *
 * 뒤로 미는 것(음수)은 넣지 않는다. 파일 수정 시각은 진짜 시계를 쓰므로 가짜 시계와
 * 영영 어긋난 상태가 되는데, 그건 현실에 없는 상황이라 잡아 봐야 헛것이다.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PRELOAD = `
const shift = Number(process.env.CLOCK_SHIFT_H || 0) * 3600000;
if (shift) {
  const RealDate = Date;
  const now = () => RealDate.now() + shift;
  globalThis.Date = new Proxy(RealDate, {
    construct(target, args) { return args.length ? new target(...args) : new target(now()); },
    get(target, prop) { return prop === 'now' ? now : Reflect.get(target, prop); },
  });
}
`;

const hours = process.argv.slice(2).length
  ? process.argv.slice(2).map(Number)
  : [0, 1, 2, 3, 4, 5, 6, 8, 10, 13, 16, 19, 22];

if (hours.some((h) => !Number.isInteger(h) || h < 0 || h > 23)) {
  console.error('시각은 0~23 사이의 정수여야 합니다.');
  process.exit(2);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cadence-clock-'));
const preload = path.join(dir, 'shift.mjs');
fs.writeFileSync(preload, PRELOAD, 'utf8');

let failed = 0;
try {
  for (const h of hours) {
    const res = spawnSync(
      process.execPath,
      // 윈도우 절대경로(C:\…)는 --import 가 프로토콜로 읽어 버린다. file:// URL 로 넘긴다.
      ['--import', pathToFileURL(preload).href, '--test', 'test/**/*.test.mjs'],
      { cwd: ROOT, env: { ...process.env, CLOCK_SHIFT_H: String(h) }, encoding: 'utf8' },
    );
    const out = `${res.stdout || ''}${res.stderr || ''}`;
    const bad = out.split('\n').filter((l) => l.startsWith('not ok '));
    const pass = /^# pass (\d+)$/m.exec(out)?.[1] ?? '?';
    if (bad.length) {
      failed++;
      console.log(`  ✗ +${h}시 — ${pass}개 통과, ${bad.length}개 실패`);
      for (const line of bad) console.log(`      ${line.replace(/^not ok \d+ - /, '')}`);
    } else {
      console.log(`  ✓ +${h}시 — ${pass}개 통과`);
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('');
if (failed) {
  console.log(`${failed}개 시각에서 실패했습니다 — 표본을 Date.now() 가 아니라 업무일 안쪽 시각으로 잡으세요.`);
  process.exit(1);
}
console.log(`${hours.length}개 시각 모두 통과 — 검사가 지금 몇 시인지에 기대지 않습니다.`);
