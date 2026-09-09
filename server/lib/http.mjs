import fs from 'node:fs';
import path from 'node:path';
import { WEB_DIR } from './config.mjs';

/** 요청 처리 중 클라이언트에게 그대로 보여줄 수 있는 오류. */
export class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

export const badRequest = (msg, detail) => new HttpError(400, msg, detail);
export const notFound = (msg = '찾을 수 없습니다') => new HttpError(404, msg);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

const MAX_BODY = 2 * 1024 * 1024; // 2 MiB — 일반 요청
export const MAX_IMPORT_BODY = 128 * 1024 * 1024; // 백업 복원은 통째로 들어온다

export async function readJsonBody(req, maxBytes = MAX_BODY) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw badRequest('요청 본문이 너무 큽니다');
    chunks.push(chunk);
  }
  if (!size) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') throw badRequest('JSON 객체가 필요합니다');
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw badRequest('JSON 파싱 실패', err.message);
  }
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(body);
}

/**
 * 라우터. `GET /api/tasks/:id` 형태의 패턴을 지원한다.
 * 핸들러는 ({ params, query, body, req, res }) 를 받고
 * 값을 반환하면 200 JSON, undefined 를 반환하면 직접 응답한 것으로 본다.
 */
export function createRouter() {
  const routes = [];

  function add(method, pattern, handler) {
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ method, pattern, parts, handler });
  }

  const api = {
    get: (p, h) => add('GET', p, h),
    post: (p, h) => add('POST', p, h),
    put: (p, h) => add('PUT', p, h),
    patch: (p, h) => add('PATCH', p, h),
    delete: (p, h) => add('DELETE', p, h),
    match(method, pathname) {
      const segs = pathname.split('/').filter(Boolean);
      for (const route of routes) {
        if (route.method !== method) continue;
        if (route.parts.length !== segs.length) continue;
        const params = {};
        let ok = true;
        for (let i = 0; i < route.parts.length; i++) {
          const p = route.parts[i];
          if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i]);
          else if (p !== segs[i]) { ok = false; break; }
        }
        if (ok) return { handler: route.handler, params };
      }
      return null;
    },
    /**
     * 등록된 경로 목록. 스모크 검사가 "모든 GET 이 500 을 내지 않는지"를
     * 직접 훑을 수 있도록 열어 둔다 — 목록을 검사 쪽에 따로 적어 두면
     * 경로가 늘어날 때마다 조용히 어긋난다.
     */
    list() {
      return routes.map((r) => ({ method: r.method, pattern: `/${r.parts.join('/')}` }));
    },
  };
  return api;
}

/** 정적 파일 서빙 — WEB_DIR 밖으로는 절대 나가지 않는다. */
export function serveStatic(pathname, res, ifNoneMatch = null) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, rel);
  const root = path.resolve(WEB_DIR);
  if (target !== root && !target.startsWith(root + path.sep)) {
    sendText(res, 403, 'forbidden');
    return true;
  }
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;

  // mtime + 크기로 만든 약한 검증자. 파일을 고치면 즉시 새로 받아 가고,
  // 그렇지 않으면 304 로 끝난다 — 개발 중 캐시 때문에 헤매는 일을 막는다.
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  const ext = path.extname(target).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': 'no-cache',
    etag,
    'last-modified': stat.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  };

  if (ifNoneMatch === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }

  headers['content-length'] = stat.size;
  res.writeHead(200, headers);
  fs.createReadStream(target).pipe(res);
  return true;
}

/**
 * Host 헤더 검증 — DNS 리바인딩으로 로컬 서버가 외부 페이지에 노출되는 것을 막는다.
 * 루프백 호스트만 허용한다.
 */
const ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function hostAllowed(hostHeader) {
  if (!hostHeader) return false;
  const host = hostHeader.replace(/:\d+$/, '').toLowerCase();
  return ALLOWED_HOSTS.has(host);
}
