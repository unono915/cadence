import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempData, at } from './helpers.mjs';

useTempData('fuzz');
process.env.CADENCE_NO_TRACKER = '1';
process.env.CADENCE_PORT = '0';

/**
 * 모든 GET 경로에 **말이 안 되는 값**을 넣어 본다.
 *
 * 스모크 검사는 제대로 된 값만 넣는다. 그래서 "쓰던 대로 쓰면 잘 된다" 까지만 지킨다.
 * 실제로 이상한 값이 들어오는 경로는 두 가지다 — 주소창에 남은 옛 링크(북마크·기록),
 * 그리고 화면이 기억해 둔 값이 낡아 그대로 날아오는 경우.
 *
 * 여기서 보려는 것은 "거절하느냐" 가 아니라 **어떻게 거절하느냐** 다.
 *  - 400 이면 좋다. 무엇이 잘못됐는지 말해 주고 끝난다.
 *  - 200 도 괜찮다. 값을 안전한 기본값으로 되돌렸다는 뜻이다.
 *  - 500 은 안 된다. 처리하지 못한 예외라는 뜻이고, 그때 화면은 "서버가 내려갔습니다"
 *    라고만 말한다. 사용자는 자기가 무엇을 잘못했는지 영영 모른다.
 *  - 그리고 어떤 경우에도 응답에 파일 경로나 스택이 섞여 나가서는 안 된다.
 */

const { buildRouter } = await import('../server/api/routes.mjs');
const { server } = await import('../server/index.mjs');
const { run, get } = await import('../server/lib/db.mjs');
const { dayKey } = await import('../server/lib/time.mjs');

let BASE = '';
before(async () => {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((r) => server.close(r));
  const { db } = await import('../server/lib/db.mjs');
  db.close();
});

// 빈 DB 로는 "행이 없어서 안 터진" 것과 구분되지 않는다.
const day = dayKey(at('2026-03-04', 10));
const category = get("SELECT id FROM categories WHERE kind = 'deep'").id;
run(
  `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
   VALUES ('Code', 'main.mjs', 'code.exe', ?, ?, 3600, 0, ?, ?)`,
  at('2026-03-04', 10), at('2026-03-04', 11), category, day,
);

/** 화면이 실제로 보내는 질의 인자 이름들. 경로를 가리지 않고 전부 넣어 본다. */
const PARAMS = [
  'day', 'from', 'to', 'days', 'weeks', 'q', 'app', 'min_sec', 'max_sec',
  'limit', 'minutes', 'started_at', 'before_day',
];

/** 넣어 볼 값들. 각 줄은 실제로 일어날 법한 사고 하나씩이다. */
const HOSTILE = [
  ['빈 값', ''],
  ['글자', 'abc'],
  ['음수', '-1'],
  ['영', '0'],
  ['너무 큰 수', '999999999999999999999999'],
  ['소수', '1.5'],
  ['NaN', 'NaN'],
  ['무한대', 'Infinity'],
  ['없는 날짜', '2026-13-45'],
  ['날짜 비슷한 것', '2026-3-4'],
  ['경로 거슬러 올라가기', '../../../windows/win.ini'],
  ['SQL 처럼 보이는 것', "' OR 1=1 --"],
  ['따옴표 섞기', `x'"\`;`],
  ['태그', '<script>alert(1)</script>'],
  ['널 문자', '%00'],
  ['아주 긴 값', 'ㄱ'.repeat(5000)],
  ['객체 흉내', '[object Object]'],
  ['배열로 두 번', null], // 아래에서 따로 만든다
];

function fill(pattern) {
  return pattern.replace(/:\w+/g, '1');
}

/** 응답 본문이 내부 사정을 흘리지 않는지. */
function leaks(text) {
  return /at [\w.]+ \(.*[\\/]/.test(text) // 스택 프레임
    || /[A-Za-z]:\\Users\\/.test(text) // 윈도우 절대경로
    || /\/server\/(api|lib)\//.test(text)
    || /node:internal/.test(text);
}

test('모든 GET 경로가 이상한 질의 인자에도 500 을 내지 않는다', async (t) => {
  const gets = buildRouter().list()
    .filter((r) => r.method === 'GET' && r.pattern !== '/api/tracker/diagnose');
  assert.ok(gets.length >= 25, `GET 경로가 ${gets.length}개뿐입니다`);

  const failures = [];
  let checked = 0;

  for (const { pattern } of gets) {
    for (const param of PARAMS) {
      for (const [label, value] of HOSTILE) {
        const qs = value === null
          ? `${param}=1&${param}=2` // 같은 인자를 두 번
          : `${param}=${encodeURIComponent(value)}`;
        const url = `${BASE}${fill(pattern)}?${qs}`;
        checked++;
        let res;
        let text;
        try {
          res = await fetch(url);
          text = await res.text();
        } catch (err) {
          failures.push(`${pattern} [${param}=${label}] → 연결이 끊겼습니다: ${err.message}`);
          continue;
        }
        if (res.status >= 500) {
          failures.push(`${pattern} [${param}=${label}] → ${res.status} ${text.slice(0, 100)}`);
        } else if (leaks(text)) {
          failures.push(`${pattern} [${param}=${label}] → 내부 경로/스택이 새어 나왔습니다: ${text.slice(0, 140)}`);
        }
      }
    }
  }

  assert.deepEqual(failures.slice(0, 12), [],
    `\n  ${failures.slice(0, 12).join('\n  ')}\n  (모두 ${failures.length}건)`);
  t.diagnostic(`경로 ${gets.length}개 × 인자 ${PARAMS.length}개 × 값 ${HOSTILE.length}가지 = ${checked}회 확인`);
});

test('본문이 망가진 POST 도 500 을 내지 않는다', async () => {
  const bodies = [
    ['빈 본문', ''],
    ['JSON 이 아닌 것', 'not json at all'],
    ['잘린 JSON', '{"title": "abc"'],
    ['배열', '[1,2,3]'],
    ['null', 'null'],
    ['숫자', '42'],
    ['깊게 중첩', `${'['.repeat(400)}${']'.repeat(400)}`],
    ['아주 큰 문자열', JSON.stringify({ title: 'ㄱ'.repeat(200_000) })],
  ];
  const failures = [];
  for (const path of ['/api/tasks', '/api/notes/append', '/api/rules', '/api/sessions', '/api/categories']) {
    for (const [label, body] of bodies) {
      const res = await fetch(BASE + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      const text = await res.text();
      if (res.status >= 500) failures.push(`${path} [${label}] → ${res.status} ${text.slice(0, 100)}`);
      else if (leaks(text)) failures.push(`${path} [${label}] → 내부 사정이 새어 나왔습니다: ${text.slice(0, 140)}`);
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`);
});
