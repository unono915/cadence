/** 서버 API 래퍼. 오류는 toast 로 올리고 호출부에는 throw 한다. */

import { toast } from './ui.js';

async function request(method, path, { query, body, raw = false } = {}) {
  const url = new URL(path, location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    toast('서버에 연결할 수 없습니다. 실행 중인지 확인하세요.', 'err');
    throw err;
  }

  if (raw) {
    const text = await res.text();
    if (!res.ok) {
      toast(`요청 실패 (${res.status})`, 'err');
      throw new Error(text);
    }
    return text;
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data.error || `요청 실패 (${res.status})`;
    toast(data.detail ? `${msg}: ${data.detail}` : msg, 'err');
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (path, query) => request('GET', path, { query }),
  getText: (path, query) => request('GET', path, { query, raw: true }),
  post: (path, body) => request('POST', path, { body }),
  put: (path, body) => request('PUT', path, { body }),
  patch: (path, body) => request('PATCH', path, { body }),
  del: (path) => request('DELETE', path),
};
