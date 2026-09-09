import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 테스트마다 격리된 데이터 디렉터리를 만든다.
 * db.mjs 는 import 시점에 파일을 열기 때문에, 반드시 모듈을 import 하기 **전에** 호출해야 한다.
 */
export function useTempData(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cadence-${name}-`));
  process.env.CADENCE_DATA_DIR = dir;
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
  });
  return dir;
}

/** 특정 날짜의 로컬 시각을 epoch ms 로. */
export function at(day, hour, minute = 0, second = 0) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d, hour, minute, second, 0).getTime();
}
