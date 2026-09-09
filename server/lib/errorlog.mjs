import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.mjs';

/**
 * 서버 오류 기록.
 *
 * 자동 실행으로 콘솔 없이 띄우면(scripts/autostart.ps1) 터미널 출력이 아무 데도 안 남는다.
 * 그러면 무언가 잘못돼도 사용자는 "그냥 안 되네" 이상을 알 수 없다.
 * 최근 것은 메모리에 두어 화면에서 바로 보여 주고, 파일로도 남겨 나중에 들여다볼 수 있게 한다.
 *
 * 개인정보가 새지 않도록 활동 내용은 절대 담지 않는다 — 오류 메시지와 발생 위치만.
 */

const LOG_PATH = path.join(DATA_DIR, 'cadence-errors.log');
const MAX_MEMORY = 50;
const MAX_FILE_BYTES = 512 * 1024;

const recent = [];

/** 파일이 커지면 뒤쪽 절반만 남긴다 — 로그가 디스크를 잠식하지 않도록. */
function rotateIfNeeded() {
  try {
    const st = fs.statSync(LOG_PATH);
    if (st.size <= MAX_FILE_BYTES) return;
    const text = fs.readFileSync(LOG_PATH, 'utf8');
    fs.writeFileSync(LOG_PATH, text.slice(Math.floor(text.length / 2)), 'utf8');
  } catch {
    // 파일이 아직 없거나 접근이 막혀 있으면 그냥 넘어간다.
  }
}

export function logError(context, err) {
  const entry = {
    at: Date.now(),
    context: String(context).slice(0, 200),
    message: String(err?.message ?? err).slice(0, 500),
  };

  recent.push(entry);
  if (recent.length > MAX_MEMORY) recent.shift();

  try {
    rotateIfNeeded();
    const stack = err?.stack ? `\n${String(err.stack).split('\n').slice(1, 4).join('\n')}` : '';
    fs.appendFileSync(
      LOG_PATH,
      `${new Date(entry.at).toISOString()} [${entry.context}] ${entry.message}${stack}\n`,
      'utf8',
    );
  } catch {
    // 기록 자체가 실패해도 서버는 계속 돌아야 한다.
  }

  return entry;
}

/** 최근 오류 (새 것부터). 설정 화면에서 보여 준다. */
export function recentErrors(limit = 20) {
  return recent.slice(-limit).reverse();
}

export function errorLogPath() {
  return LOG_PATH;
}

export function clearErrors() {
  recent.length = 0;
  try { fs.rmSync(LOG_PATH, { force: true }); } catch { /* 이미 없음 */ }
  return { cleared: true };
}
