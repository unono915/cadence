import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * 서버를 **실제로 띄워** 기동과 종료를 확인한다.
 *
 * 여기 있는 것들은 다른 검사가 닿지 못하는 자리다 — 포트가 막혔을 때의 분기, 종료 신호,
 * 부팅 로그. 전부 사용자가 가장 흔하게 겪는 경로인데(아이콘을 두 번 누르기, 창 닫기)
 * 모듈을 불러오는 방식으로는 확인할 수 없다.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const ENTRY = path.join(ROOT, 'server', 'index.mjs');

/**
 * 지금 비어 있는 포트를 하나 얻는다 — 고정 포트를 쓰면 다른 검사와 부딪힌다.
 * `listen()` 은 비동기라, 붙기를 기다려야 주소가 생긴다.
 *
 * 여는 순간과 서버가 붙는 순간 사이에 다른 검사가 그 포트를 채 갈 수 있으므로,
 * 이 방식은 **먼저 잡아 두고 쓰는 경우**(아래 '남의 프로그램' 검사)에만 쓴다.
 * 그냥 서버를 띄우는 쪽은 `CADENCE_PORT=0` 으로 운영체제에게 고르게 하고,
 * 실제로 붙은 포트를 기동 로그에서 읽는다.
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function tempDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cadence-${name}-`));
  process.on('exit', () => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패는 무시 */ }
  });
  return dir;
}

function launch(dir, port = 0) {
  return spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      CADENCE_DATA_DIR: dir,
      CADENCE_PORT: String(port),
      CADENCE_NO_TRACKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** 기동 로그에서 실제로 붙은 포트를 읽는다. */
async function portOf(output, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output());
    if (m) return Number(m[1]);
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`기동 로그에 주소가 나오지 않았습니다: ${output().slice(0, 300)}`);
}

/** 서버가 응답할 때까지 기다린다. 고정 시간 sleep 은 느리거나 불안정하다. */
async function waitReady(port, ms = 15_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(700) });
      if (res.ok) return await res.json();
    } catch { /* 아직 안 떴다 */ }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`${port} 포트에서 서버가 뜨지 않았습니다`);
}

function collect(child) {
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  return () => out;
}

test('첫 실행은 데이터 폴더를 만들고 기본값을 심는다', async () => {
  const dir = tempDir('boot');
  const child = launch(dir);          // 포트는 운영체제가 고른다
  const output = collect(child);

  try {
    const port = await portOf(output);
    const health = await waitReady(port);
    assert.equal(health.ok, true);
    assert.match(health.today, /^\d{4}-\d{2}-\d{2}$/);

    const cats = await (await fetch(`http://127.0.0.1:${port}/api/categories`)).json();
    assert.ok(cats.length >= 8, `기본 카테고리가 ${cats.length}개뿐입니다`);
    const rules = await (await fetch(`http://127.0.0.1:${port}/api/rules`)).json();
    assert.ok(rules.length >= 40, `기본 규칙이 ${rules.length}개뿐입니다`);

    assert.ok(fs.existsSync(path.join(dir, 'cadence.db')), 'DB 파일이 없습니다');
    assert.match(output(), /Cadence/, '기동 안내가 없습니다');
    // 첫 실행에는 "규칙을 더했습니다" 가 나오면 안 된다 — 심은 것이지 올린 것이 아니다.
    assert.doesNotMatch(output(), /기본 분류 규칙 \d+개를 더했습니다/);
  } finally {
    child.kill();
  }
});

test('이미 켜져 있으면 두 번째 실행은 그렇게 말하고 조용히 물러난다', async () => {
  // 열에 아홉은 시작프로그램으로 이미 떠 있는 상태에서 아이콘을 한 번 더 누른 것이다.
  // 그때 "포트가 막혔습니다" 라고 하면 대개 틀린 안내다.
  const dir = tempDir('boot-dup');
  const first = launch(dir);
  const firstOut = collect(first);

  try {
    const port = await portOf(firstOut);
    await waitReady(port);

    const second = spawnSync(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env, CADENCE_DATA_DIR: dir, CADENCE_PORT: String(port), CADENCE_NO_TRACKER: '1',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const text = `${second.stdout || ''}${second.stderr || ''}`;
    assert.match(text, /이미 실행 중입니다/, `두 번째 실행의 출력: ${text.slice(0, 300)}`);
    assert.equal(second.status, 0, '이미 켜져 있는 것은 오류가 아니므로 0 으로 끝나야 한다');

    // 먼저 뜬 쪽은 멀쩡해야 한다 — 두 번째가 무언가를 망가뜨리지 않았는지.
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()).ok, true);
  } finally {
    first.kill();
  }
});

test('다른 프로그램이 포트를 잡고 있으면 다른 포트를 안내하고 실패로 끝난다', async () => {
  // 위와 겉모습은 같지만 답이 정반대다. 우리 것이 아니면 포트를 바꾸라고 해야 한다.
  const dir = tempDir('boot-busy');
  const port = await freePort();
  const squatter = net.createServer((s) => s.end());
  await new Promise((r) => squatter.listen(port, '127.0.0.1', r));

  try {
    const res = spawnSync(process.execPath, [ENTRY], {
      cwd: ROOT,
      env: {
        ...process.env, CADENCE_DATA_DIR: dir, CADENCE_PORT: String(port), CADENCE_NO_TRACKER: '1',
      },
      encoding: 'utf8',
      timeout: 20_000,
    });

    const text = `${res.stdout || ''}${res.stderr || ''}`;
    assert.match(text, /CADENCE_PORT/, `안내가 없습니다: ${text.slice(0, 300)}`);
    assert.doesNotMatch(text, /이미 실행 중입니다/, '남의 프로그램을 우리 것으로 봤습니다');
    assert.equal(res.status, 1, '뜨지 못한 것은 실패로 끝나야 한다');
  } finally {
    squatter.close();
  }
});

test('데이터 폴더를 쓸 수 없으면 읽을 수 있는 말로 멈춘다', () => {
  // 이 확인은 모듈을 불러오는 순간 돌기 때문에, 실패하면 사용자가 보는 것은 Node 의 원시
  // 스택 트레이스다 — `start.cmd` 로 띄웠다면 창 가득 영문 스택이 뜨고 그걸로 끝이다.
  // 흔한 상황이다: 경로 오타, 연결이 끊긴 네트워크·외장 드라이브, 동기화 폴더 권한.
  const dir = tempDir('boot-badpath');
  const blocker = path.join(dir, 'file.txt');
  fs.writeFileSync(blocker, '폴더가 아님');

  const res = spawnSync(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      CADENCE_DATA_DIR: path.join(blocker, 'sub'),   // 파일 안쪽 경로 — 만들 수 없다
      CADENCE_PORT: '0',
      CADENCE_NO_TRACKER: '1',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });

  const text = `${res.stdout || ''}${res.stderr || ''}`;
  assert.match(text, /데이터 폴더를 쓸 수 없어/, `안내가 없습니다: ${text.slice(0, 300)}`);
  assert.match(text, /CADENCE_DATA_DIR/, '무엇을 고쳐야 하는지 말해야 한다');
  assert.doesNotMatch(text, /at Object\.mkdirSync|node:internal/, '원시 스택을 그대로 보여주면 안 된다');
  assert.equal(res.status, 1, '시작하지 못한 것은 실패로 끝나야 한다');
});

test('데이터베이스가 깨져 있으면 사본을 가리키며 멈춘다', () => {
  // 정전 뒤 파일이 잘리거나, 동기화 폴더가 충돌 사본을 만들어 놓는 일은 실제로 일어난다.
  // 그때 Node 의 원시 스택만 보여 주면 사용자가 할 수 있는 일이 없다 —
  // 게다가 그 안에는 그 사람의 기록 전부가 들어 있어서 함부로 지우라고 할 수도 없다.
  const dir = tempDir('boot-corrupt');
  fs.writeFileSync(path.join(dir, 'cadence.db'), Buffer.from('이건 데이터베이스가 아닙니다'));

  const res = spawnSync(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env, CADENCE_DATA_DIR: dir, CADENCE_PORT: '0', CADENCE_NO_TRACKER: '1',
    },
    encoding: 'utf8',
    timeout: 20_000,
  });

  const text = `${res.stdout || ''}${res.stderr || ''}`;
  assert.match(text, /데이터베이스를 열지 못해/, `안내가 없습니다: ${text.slice(0, 300)}`);
  assert.match(text, /cadence-backup/, '되돌릴 방법을 알려 줘야 한다');
  assert.match(text, /지우지 말고/, '원본을 지우라고 하면 안 된다');
  assert.doesNotMatch(text, /node:internal|at new DatabaseSync/, '원시 스택을 그대로 보여주면 안 된다');
  assert.equal(res.status, 1);
});

test('종료 신호를 받으면 정리하고 나간다', async () => {
  const dir = tempDir('boot-stop');
  const child = launch(dir);
  const output = collect(child);

  const port = await portOf(output);
  await waitReady(port);
  // 태스크를 하나 만들어 두고, 종료 뒤에도 파일에 남아 있는지 본다.
  await fetch(`http://127.0.0.1:${port}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '종료 전에 만든 태스크' }),
  });

  // 윈도우에는 유닉스 신호가 없다. `kill()` 은 프로세스를 바로 끊고, 종료 코드는 null 에
  // 신호 이름만 남는다 — 그래서 코드로 판단하면 안 된다. 여기서 확인하는 것은
  // "나가는가" 와 "나간 뒤에도 기록이 남는가" 다. 정리 절차 자체(SIGTERM 처리)는
  // 신호를 보낼 수 있는 곳에서만 확인한다.
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
    child.kill('SIGTERM');
  });
  assert.equal(exited, true, '종료 신호를 보냈는데 나가지 않았습니다');
  if (process.platform !== 'win32') assert.match(output(), /정리 중/);

  // 다시 띄웠을 때 그 태스크가 그대로 있어야 한다 — 갑자기 끊겨도 기록이 남는다는 뜻.
  const again = launch(dir);
  const againOut = collect(again);
  try {
    const port2 = await portOf(againOut);
    await waitReady(port2);
    const tasks = await (await fetch(`http://127.0.0.1:${port2}/api/tasks`)).json();
    assert.ok(tasks.some((t) => t.title === '종료 전에 만든 태스크'), '종료 뒤 기록이 사라졌습니다');
  } finally {
    again.kill();
  }
});

/**
 * 브라우저를 못 열어도 서버는 산다.
 *
 * 아이콘으로 실행하면 서버가 콘솔을 브라우저로 열어 준다. 그 일이 실패하는 상황은
 * 얼마든지 있다 — 기본 브라우저가 없거나, 여는 명령이 PATH 에 없거나, 보안 정책이 막거나.
 *
 * 문제는 `spawn()` 이 실행 파일을 못 찾아도 **던지지 않는다**는 것이다. 대신 잠시 뒤
 * 'error' 를 쏘고, 그걸 받는 데가 없으면 노드가 **프로세스를 죽인다.** try/catch 로는
 * 안 잡힌다. 브라우저를 못 여는 사소한 일 때문에 기록이 통째로 멈추는 셈이다.
 *
 * 여기서는 PATH 를 비우고 띄운다. 다만 윈도우에서는 `cmd` 가 PATH 와 무관하게 늘 찾아지므로
 * 이 검사만으로는 그 갈래에 닿지 못한다 — 리눅스에서 `xdg-open` 이 없을 때가 진짜 상황이다.
 * 그래서 아래에 원문 검사를 따로 둔다. 둘을 합쳐야 지켜진다.
 */
test('브라우저 여는 명령이 없어도 서버가 죽지 않는다', async () => {
  const dir = tempDir('open-fail');
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      CADENCE_DATA_DIR: dir,
      CADENCE_PORT: '0',
      CADENCE_NO_TRACKER: '1',
      CADENCE_OPEN: '1',
      // 여는 명령을 찾을 수 없게 만든다. 진짜 브라우저를 띄우지 않으려는 뜻도 있다 —
      // 검사가 사람 화면에 창을 띄우기 시작하면 아무도 그 검사를 돌리지 않게 된다.
      PATH: dir,
      Path: dir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = collect(child);
  try {
    const port = await portOf(output);
    const health = await waitReady(port);
    assert.equal(health.ok, true);
    // 열기를 시도하고도 한참 살아 있어야 한다 — 'error' 는 조금 뒤에 온다.
    await new Promise((r) => setTimeout(r, 800));
    const again = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(again.ok, true, '브라우저를 못 연 뒤 서버가 내려갔습니다');
  } finally {
    child.kill();
  }
});

/**
 * 여는 일을 서버가 맡고 있는지.
 *
 * 예전에는 `start.cmd` 가 2초를 세고 **무조건** 열었다. 서버가 뜨지 못한 날에도 브라우저가
 * 열려, 사용자는 터미널의 안내 대신 "연결할 수 없음" 을 봤다. 포트를 다른 프로그램이
 * 쓰고 있으면 더 나빴다 — 남의 페이지가 열려 Cadence 인 척했다.
 */
test('실행 스크립트가 스스로 브라우저를 열지 않는다', () => {
  const cmd = fs.readFileSync(path.join(ROOT, 'start.cmd'), 'utf8');
  assert.match(cmd, /set CADENCE_OPEN=1/, '서버에 열라고 알려 주지 않습니다');
  assert.doesNotMatch(cmd, /start "" http:/,
    '스크립트가 직접 브라우저를 엽니다 — 서버가 뜨지 못해도 열립니다');

  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.mjs'), 'utf8');
  assert.match(src, /process\.env\.CADENCE_OPEN !== '1'/,
    '환경 변수 없이도 열면 검사·개발 중에 창이 튀어나옵니다');
  assert.match(src, /openConsole\(`http:\/\/\$\{HOST\}:\$\{server\.address\(\)\.port\}`\)/,
    '설정값이 아니라 실제로 붙은 포트로 열어야 합니다');
  // `spawn` 의 실패는 예외가 아니라 이벤트로 온다. 받는 데가 없으면 서버가 죽는다.
  // 윈도우에서는 `cmd` 가 늘 찾아져 이 갈래에 닿지 못하므로 원문으로 확인한다.
  assert.match(src, /child\.on\('error'/,
    "spawn 의 'error' 를 받지 않으면, 브라우저를 못 여는 것만으로 서버가 통째로 죽습니다");
});
