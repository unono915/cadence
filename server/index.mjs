import http from 'node:http';
import { spawn } from 'node:child_process';
import { HOST, PORT, DATA_DIR, DB_PATH } from './lib/config.mjs';
import { db, startWalMaintenance } from './lib/db.mjs';
import {
  HttpError, readJsonBody, sendJson, sendText, serveStatic, hostAllowed, MAX_IMPORT_BODY,
} from './lib/http.mjs';
import { seedDefaults, upgradeDefaults } from './lib/categorize.mjs';
import { applyRuntimeSettings } from './api/misc.mjs';
import { buildRouter } from './api/routes.mjs';
import { tracker, bootTracker } from './tracker/tracker.mjs';
import { logError } from './lib/errorlog.mjs';
import { startAutoSnapshot } from './api/backup.mjs';

const fresh = seedDefaults();
// 새로 추가된 기본 규칙은 이미 쓰고 있는 사람에게도 닿아야 한다.
// 첫 실행이면 seedDefaults() 가 전부 심었으므로 건너뛴다.
const upgraded = fresh ? null : upgradeDefaults();
applyRuntimeSettings();

/**
 * 콘텐츠 보안 정책.
 *
 * 이 화면은 다른 프로그램이 정한 창 제목을 그대로 그린다. 코드 쪽에는 innerHTML 을
 * 한 군데도 두지 않았지만(test/no-html-sink.test.mjs 가 지킨다), 그 규칙이 언젠가
 * 깨졌을 때 마지막으로 막아 주는 것이 이 헤더다.
 *
 * 밖으로 나가는 요청이 하나도 없는 앱이므로 기본값을 'none' 으로 두고 쓰는 것만 연다.
 * 스타일은 'unsafe-inline' 을 허용한다 — 차트가 SVG 요소에 style 속성을 직접 얹는데,
 * 주입 통로가 없는 상태에서 인라인 스타일이 여는 위험은 사실상 없고, 막으면 화면이 깨진다.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const router = buildRouter();

const server = http.createServer({
  // 기본값(30초)마다 한 번씩만 확인하면 아래 타임아웃이 그만큼 늦게 걸린다.
  connectionsCheckingInterval: 5_000,
}, async (req, res) => {
  const started = Date.now();
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    sendText(res, 400, 'bad request');
    return;
  }

  // 로컬 전용 서버 — DNS 리바인딩과 외부 오리진 접근을 차단한다.
  if (!hostAllowed(req.headers.host)) {
    sendText(res, 403, 'forbidden: 로컬호스트에서만 접근할 수 있습니다');
    return;
  }
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)) {
    sendText(res, 403, 'forbidden: 허용되지 않은 오리진');
    return;
  }

  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', CSP);

  try {
    const match = router.match(req.method, url.pathname);
    if (match) {
      const query = Object.fromEntries(url.searchParams.entries());
      const limit = url.pathname === '/api/import' ? MAX_IMPORT_BODY : undefined;
      const body = await readJsonBody(req, limit);
      const out = await match.handler({ params: match.params, query, body, req, res });
      if (out !== undefined && !res.writableEnded) sendJson(res, 200, out);
      else if (!res.writableEnded) sendJson(res, 204, {});
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      sendJson(res, 404, { error: '알 수 없는 API 경로', path: url.pathname });
      return;
    }

    const inm = req.headers['if-none-match'] || null;
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(url.pathname, res, inm)) return;

    // SPA 폴백 — 새로고침해도 라우팅이 살아 있도록.
    if (req.method === 'GET' && serveStatic('/', res, inm)) return;

    sendText(res, 404, 'not found');
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message, detail: err.detail ?? null });
    } else {
      logError(`${req.method} ${url.pathname}`, err);
      console.error(`[cadence] ${req.method} ${url.pathname} 실패 (${Date.now() - started}ms)`, err);
      sendJson(res, 500, { error: '서버 내부 오류', detail: err.message });
    }
  }
});

/**
 * 응답 없이 붙어만 있는 연결을 오래 붙잡아 두지 않는다.
 *
 * `Content-Length` 만 적어 놓고 본문을 안 보내면 요청 처리가 그대로 멈춰 선다.
 * 로컬 전용 서버라 노리는 사람은 없겠지만, 포트 스캐너나 잘못 붙은 프로그램 하나로도
 * 연결이 몇 분씩 남는다. 기본값(5분)은 이 앱에 견주면 지나치게 길다.
 *
 * 백업 복원은 본문이 수십 MB 까지 가지만 루프백이라 몇 초면 끝난다 — 60초면 넉넉하다.
 *
 * 실제로 끊기는 시점은 타임아웃이 아니라 위의 확인 주기에 걸린다. 짧게 잡고 재 본 결과
 * (requestTimeout 2초, 주기 5초) 10초 뒤 408 이 돌아왔다 — 확인 주기 안에서만 정확하다.
 */
/**
 * 콘솔을 브라우저로 연다. `start.cmd` 가 `CADENCE_OPEN=1` 을 켤 때만 동작한다.
 *
 * 예전에는 `start.cmd` 가 2초를 세고 무조건 브라우저를 열었다. 그래서 서버가 뜨지 못한
 * 날에도 브라우저는 열렸고, 사용자가 보는 것은 터미널의 한국어 안내가 아니라
 * **"연결할 수 없음"** 이었다 — 무엇이 잘못됐는지 알려 주는 글은 뒤에 가려진 검은 창에
 * 있었다. 포트를 다른 프로그램이 쓰고 있을 때는 더 나빴다. 브라우저가 **남의 페이지**를
 * 열어 놓고 Cadence 인 척했다.
 *
 * 그래서 여는 일을 서버가 맡는다. 실제로 듣기 시작했을 때, 실제로 붙은 포트로만 연다.
 * (이미 켜져 있어서 물러나는 경우에도 연다 — 아이콘을 두 번 누른 사람이 원하는 것은
 * 그 화면이지, "이미 실행 중" 이라는 문장이 아니다.)
 */
function openConsole(url) {
  if (process.env.CADENCE_OPEN !== '1') return;
  const [cmd, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    // `spawn` 은 실행 파일을 못 찾아도 **던지지 않는다.** 대신 잠시 뒤 'error' 를 쏘는데,
    // 그걸 받는 데가 없으면 노드가 처리되지 않은 이벤트로 보고 **프로세스를 죽인다.**
    // 브라우저를 못 여는 것 때문에 서버가 통째로 내려가는 셈이라, 반드시 받아 둔다.
    child.on('error', () => {});
    child.unref();
  } catch {
    // 못 열어도 주소는 바로 위에 찍혀 있다. 이것 때문에 서버가 죽을 이유는 없다.
  }
}

server.requestTimeout = 60_000;
server.headersTimeout = 10_000;

server.listen(PORT, HOST, () => {
  const status = bootTracker();
  startWalMaintenance();
  startAutoSnapshot();
  console.log('');
  console.log('  Cadence — 로컬 업무 생산성 콘솔');
  // 설정값이 아니라 **실제로 붙은 포트**를 적는다. `CADENCE_PORT=0` 으로 띄우면
  // 운영체제가 빈 포트를 골라 주는데, 설정값을 그대로 적으면 "http://127.0.0.1:0" 이라는
  // 열 수 없는 주소를 안내하게 된다.
  console.log(`  ▸ http://${HOST}:${server.address().port}`);
  console.log(`  ▸ 데이터: ${DB_PATH}`);
  console.log(`  ▸ 자동 추적: ${status.running ? '동작 중' : status.supported ? '대기/일시정지' : '미지원 플랫폼'}`);
  if (upgraded?.added) {
    console.log(`  ▸ 기본 분류 규칙 ${upgraded.added}개를 더했습니다 (기존 기록 ${upgraded.recategorized}건 재분류)`);
  }
  if (status.lastError) console.log(`  ▸ 참고: ${status.lastError}`);
  console.log('');
  openConsole(`http://${HOST}:${server.address().port}`);
});

/**
 * 이미 켜져 있는 Cadence 인지 확인한다.
 *
 * 포트가 막혔을 때 "다른 포트를 쓰세요" 라고만 하면, 대개는 잘못된 안내다 —
 * 열에 아홉은 시작프로그램으로 이미 떠 있는 상태에서 아이콘을 한 번 더 누른 것이다.
 * 그때 필요한 것은 새 포트가 아니라 "이미 켜져 있습니다" 한 줄이다.
 */
async function isOurServer() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.ok === true && typeof body.day_start_hour === 'number';
  } catch {
    return false;
  }
}

server.on('error', async (err) => {
  if (err.code === 'EADDRINUSE') {
    if (await isOurServer()) {
      // 콘솔 없이 자동 실행된 경우를 대비해 파일에도 남긴다.
      logError('server.listen', new Error(`Cadence 가 이미 ${HOST}:${PORT} 에서 실행 중입니다`));
      console.log(`[cadence] 이미 실행 중입니다 — http://${HOST}:${PORT} 를 여세요.`);
      openConsole(`http://${HOST}:${PORT}`);
      process.exit(0);
    }
    const message = `포트 ${PORT} 를 다른 프로그램이 쓰고 있습니다. CADENCE_PORT 로 다른 포트를 지정하세요.`;
    logError('server.listen', new Error(message));
    console.error(`[cadence] ${message}`);
    process.exit(1);
  }
  logError('server', err);
  console.error('[cadence] 서버 오류', err);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[cadence] ${signal} — 정리 중…`);
  try { tracker.stop(); } catch (err) { console.error(err); }
  server.close(() => {
    try {
      // 마지막 기록까지 본 파일에 넘긴 뒤 닫는다 — 곧바로 파일을 복사해도 최신이도록.
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      db.close();
    } catch { /* 이미 닫힘 */ }
    process.exit(0);
  });
  // 열린 커넥션이 남아도 오래 매달리지 않는다.
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
  console.error('[cadence] 처리되지 않은 예외', err);
});

process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  console.error('[cadence] 처리되지 않은 거부', reason);
});

export { server, DATA_DIR };
