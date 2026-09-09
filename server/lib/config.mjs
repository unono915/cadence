import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 프로젝트 루트 (cadence/) */
export const ROOT = path.resolve(here, '..', '..');

/**
 * 데이터 디렉터리.
 * 기본값은 %LOCALAPPDATA%\Cadence (Windows) / ~/.local/share/cadence (기타).
 * CADENCE_DATA_DIR 로 덮어쓸 수 있다 — 테스트와 휴대용 실행에 사용.
 */
export const DATA_DIR = process.env.CADENCE_DATA_DIR
  ? path.resolve(process.env.CADENCE_DATA_DIR)
  : process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Cadence')
    : path.join(os.homedir(), '.local', 'share', 'cadence');

/**
 * 데이터 폴더를 만든다. 못 만들면 **읽을 수 있는 말로** 멈춘다.
 *
 * 이 줄은 모듈을 불러오는 순간 돌기 때문에, 실패하면 사용자가 보는 것은 Node 의 원시
 * 스택 트레이스다 — `start.cmd` 로 띄웠다면 창 가득 영문 스택이 뜨고 그걸로 끝이다.
 * 실제로 흔한 상황이다: `CADENCE_DATA_DIR` 오타, 연결이 끊긴 네트워크·외장 드라이브,
 * 동기화 폴더의 권한 문제. 무엇을 고쳐야 하는지 한 줄로 말해 준다.
 */
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 만들어졌더라도 쓸 수 있는지는 별개다 — 읽기 전용 폴더나 꽉 찬 디스크가 그렇다.
  fs.accessSync(DATA_DIR, fs.constants.W_OK);
} catch (err) {
  const why = err.code === 'ENOTDIR' ? '경로 중간에 폴더가 아닌 것이 있습니다'
    : err.code === 'EACCES' || err.code === 'EPERM' ? '권한이 없습니다'
      : err.code === 'ENOENT' ? '경로를 찾을 수 없습니다 (연결이 끊긴 드라이브일 수 있습니다)'
        : err.code === 'ENOSPC' ? '디스크에 공간이 없습니다'
          : err.message;
  console.error('');
  console.error('[cadence] 데이터 폴더를 쓸 수 없어 시작하지 못했습니다.');
  console.error(`  폴더: ${DATA_DIR}`);
  console.error(`  이유: ${why}`);
  console.error('  CADENCE_DATA_DIR 로 다른 폴더를 지정하거나, 위 경로의 권한을 확인하세요.');
  console.error('');
  process.exit(1);
}

export const DB_PATH = path.join(DATA_DIR, 'cadence.db');
export const WEB_DIR = path.join(ROOT, 'web');

/** 서버는 기본적으로 루프백에만 바인딩한다 — 개인 활동 데이터가 외부에 노출되지 않도록. */
export const HOST = process.env.CADENCE_HOST || '127.0.0.1';
export const PORT = Number(process.env.CADENCE_PORT || 4321);

/** 자동 추적기 폴링 주기(ms)와 유휴 판정 임계값(초). */
export const TRACKER_POLL_MS = Number(process.env.CADENCE_POLL_MS || 4000);
export const IDLE_THRESHOLD_S = Number(process.env.CADENCE_IDLE_S || 120);
