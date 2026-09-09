import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { ROOT, DATA_DIR, TRACKER_POLL_MS, IDLE_THRESHOLD_S } from '../lib/config.mjs';
import { run, get, setting, setSetting } from '../lib/db.mjs';
import { categorize } from '../lib/categorize.mjs';
import { dayKey, dayRange } from '../lib/time.mjs';
import { sanitizeTitle } from '../lib/text.mjs';
import { LIMITS } from '../../web/lib/limits.js';

// 마이그레이션도 같은 규칙으로 다듬어야 하므로 lib/text.mjs 로 옮겼다. 부르는 쪽은 그대로 둔다.
export { sanitizeTitle };

const here = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(here, 'win-probe.ps1');

/** 이만큼 문제없이 돌았다면 앞선 실패는 잊는다 (재시작 대기 시간 계산용). */
const HEALTHY_RUN_MS = 5 * 60_000;

/** 3초 미만의 스쳐 지나간 창은 노이즈로 보고 버린다. */
const MIN_SEGMENT_S = 3;

/**
 * 포그라운드에 있어도 "사람이 앞에 없는" 창들.
 *
 * 화면을 잠그면 포그라운드 창은 잠금 화면(LockApp/LogonUI)이 된다. 그런데 잠그는 행위
 * 자체가 입력이라 유휴 판정은 임계값만큼 늦게 걸린다 — 그 사이 몇 분이 'LockApp.exe'
 * 라는 앱을 쓴 시간으로 기록되고, 많이 쓴 앱 목록에까지 올라온다.
 * 화면보호기도 마찬가지다. 이런 창은 시간과 관계없이 곧바로 자리비움으로 본다.
 */
const AWAY_PROCESSES = new Set(['lockapp', 'logonui', 'lockappost']);

/** 같은 구간으로 볼 시작 시각의 오차. 소급 시점이 밀리초 단위로 흔들리기 때문. */
const TWIN_TOLERANCE_MS = 2000;

/**
 * 포그라운드 창을 아예 알아내지 못한 샘플인지. 이것도 활동으로 셀 근거가 없다.
 *
 * 'Unknown' 도 함께 본다 — 예전 프로브는 이름을 못 찾았을 때 그 문자열을 지어냈고,
 * 그 기록이 "많이 쓴 앱" 목록에 진짜 앱처럼 올라와 있었다.
 */
function isBlank(sample) {
  const app = String(sample.app || '').trim();
  const proc = String(sample.proc || '').trim();
  if (!app && !proc) return true;
  return app === 'Unknown' && !proc;
}

function isAway(sample) {
  const proc = String(sample.proc || '').toLowerCase().replace(/\.exe$/, '');
  return AWAY_PROCESSES.has(proc) || proc.endsWith('.scr') || isBlank(sample);
}

/**
 * 재시작 뒤 자리비움 구간을 이어받을 수 있는 최대 공백.
 * 서버가 내려가 있던 동안도 자리를 비운 것은 마찬가지이므로 넉넉해도 기록이 왜곡되지 않는다.
 */
const ADOPT_IDLE_GRACE_MS = 30 * 60_000;

/**
 * 같은 데이터 폴더에서 추적기가 둘 이상 돌지 않게 한다.
 *
 * 흔한 경로가 하나 있다. 시작프로그램으로 이미 떠 있는데 포트가 겹친다는 안내를 보고
 * `CADENCE_PORT` 만 바꿔 다시 띄우는 것 — 그러면 서버는 둘, 데이터 폴더는 하나다.
 * 추적기 두 개가 같은 활동을 각자 기록하면서 서로가 붙잡은 행을 이어받으려 들고,
 * 하루 합계가 조용히 두 배로 부풀어 오른다. 화면은 멀쩡해 보인다.
 *
 * 잠금은 심장박동 방식이다. 살아 있는 쪽이 주기적으로 시각을 갱신하고, 갑자기 죽으면
 * 잠시 뒤 저절로 낡은 것이 된다 — 죽은 프로세스의 잠금 파일에 발이 묶이지 않도록.
 */
const LOCK_PATH = path.join(DATA_DIR, 'tracker.lock');
const LOCK_WRITE_MS = 10_000;

function readLock() {
  try {
    return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 포그라운드 활동 추적기.
 *
 * 설계 요점
 *  - 세그먼트(같은 앱/제목이 연속된 구간)를 DB 에 즉시 INSERT 하고, 폴링마다 종료 시각을
 *    UPDATE 한다. 프로세스가 갑자기 죽어도 마지막 폴링까지의 기록이 남는다.
 *  - 유휴 전환은 "마지막 입력 시각"을 경계로 삼아 소급 정산한다. 임계값만큼 뒤늦게
 *    감지하더라도 실제로 손을 뗀 시점에서 잘린다.
 *  - 절전/최대 절전으로 폴링이 끊긴 구간은 아예 기록하지 않는다.
 */
export class Tracker extends EventEmitter {
  constructor({ pollMs = TRACKER_POLL_MS, idleThresholdS = IDLE_THRESHOLD_S } = {}) {
    super();
    this.pollMs = pollMs;
    this.idleThresholdMs = idleThresholdS * 1000;
    this.child = null;
    this.open = null;
    this.lastSampleAt = 0;
    this.paused = false;
    this.buffer = '';
    this.startedAt = null;
    this.lastError = null;
    this.sampleCount = 0;
    this.restarts = 0;
    this.stopping = false;
    this.restartTimer = null;
    // 부팅/재개 후 첫 구간에서만 직전 기록을 이어받는다.
    this.adoptOnNextOpen = false;
    this.lastLockAt = 0;
  }

  get supported() {
    return process.platform === 'win32';
  }

  get captureTitles() {
    return setting('capture_titles', '1') !== '0';
  }

  status() {
    return {
      supported: this.supported,
      running: Boolean(this.child) && !this.paused,
      paused: this.paused,
      startedAt: this.startedAt,
      pollMs: this.pollMs,
      idleThresholdS: this.idleThresholdMs / 1000,
      samples: this.sampleCount,
      restarts: this.restarts,
      lastSampleAt: this.lastSampleAt || null,
      lastError: this.lastError,
      captureTitles: this.captureTitles,
      current: this.open
        ? {
            app: this.open.app,
            title: this.open.title,
            idle: Boolean(this.open.idle),
            startedAt: this.open.started_at,
            seconds: Math.round((Date.now() - this.open.started_at) / 1000),
            // 지금 하고 있는 일이 어느 종류인지. 집중 세션 중에 딴 데로 새는 것을
            // 화면 쪽에서 알아채려면 이 값이 필요하다. 기본키 조회라 사실상 공짜다.
            category: this.#currentCategory(),
          }
        : null,
    };
  }

  #currentCategory() {
    const id = this.open?.category_id;
    if (!id) return null;
    const row = get('SELECT id, name, kind FROM categories WHERE id = ?', id);
    return row || null;
  }

  /**
   * 잠금이 살아 있는 다른 프로세스의 것인지. 낡은 잠금은 없는 것으로 본다.
   *
   * 시각만 보면 충분하지 않다. 작업 관리자로 강제 종료하거나 전원이 나가면 잠금 파일이
   * 그대로 남는데, 곧바로 다시 켠 경우 심장박동이 아직 '싱싱해' 보여서 자기 자신의
   * 유령에게 막힌다. 그래서 그 프로세스가 실제로 살아 있는지도 함께 본다.
   * (signal 0 은 신호를 보내지 않고 존재 여부만 확인한다.)
   */
  #lockedByOther() {
    const lock = readLock();
    if (!lock || lock.pid === process.pid) return null;
    const stale = Math.max(15_000, this.pollMs * 3);
    if (Date.now() - Number(lock.at || 0) > stale) return null;
    try {
      process.kill(lock.pid, 0);
    } catch {
      return null; // 그 프로세스는 이미 없다 — 남은 잠금일 뿐이다.
    }
    return lock;
  }

  #writeLock() {
    this.lastLockAt = Date.now();
    try {
      fs.writeFileSync(LOCK_PATH, JSON.stringify({ pid: process.pid, at: this.lastLockAt }));
    } catch {
      // 잠금을 못 써도 추적 자체는 계속한다 — 안전장치가 기능을 막아서는 안 된다.
    }
  }

  #releaseLock() {
    const lock = readLock();
    if (lock && lock.pid !== process.pid) return;
    try { fs.rmSync(LOCK_PATH, { force: true }); } catch { /* 이미 없음 */ }
  }

  start() {
    if (!this.supported) {
      this.lastError = `자동 추적은 Windows 에서만 동작합니다 (현재: ${process.platform})`;
      return false;
    }
    if (this.child) return true;

    const other = this.#lockedByOther();
    if (other) {
      this.lastError = `다른 Cadence(프로세스 ${other.pid})가 같은 데이터 폴더를 추적하고 있어 시작하지 않았습니다. `
        + '같은 폴더에서 둘이 함께 기록하면 시간이 두 배로 잡힙니다.';
      return false;
    }
    this.#writeLock();

    // 프로브를 띄우지 않는 모드. 검사와 헤드리스 실행에서 쓴다.
    // (예전에는 bootTracker 만 이 변수를 봤는데, 그러면 tracker.start() 를 직접 부르는
    //  쪽에서는 아무 소용이 없어 검사가 실제 PowerShell 프로세스를 남겼다.)
    if (process.env.CADENCE_NO_TRACKER === '1') return false;

    this.stopping = false;
    this.adoptOnNextOpen = true;

    const args = [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-File', PROBE,
      '-IntervalMs', String(this.pollMs),
    ];

    try {
      this.child = spawn('powershell.exe', args, {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.lastError = `프로브 실행 실패: ${err.message}`;
      this.child = null;
      return false;
    }

    this.startedAt = Date.now();
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onChunk(chunk));
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (msg) => {
      const text = String(msg).trim();
      if (text) this.lastError = text.slice(0, 500);
    });
    this.child.on('exit', (code) => this.onExit(code));
    this.child.on('error', (err) => {
      this.lastError = err.message;
    });
    return true;
  }

  /**
   * 설정 변경 반영.
   * 유휴 임계값은 즉시 적용되지만, 폴링 주기는 프로브에 인자로 넘어가므로
   * 실제로 바뀌려면 프로브를 다시 띄워야 한다.
   */
  applySettings({ pollMs, idleThresholdS } = {}) {
    if (Number.isFinite(idleThresholdS) && idleThresholdS > 0) {
      this.idleThresholdMs = idleThresholdS * 1000;
    }
    if (!Number.isFinite(pollMs) || pollMs <= 0 || pollMs === this.pollMs) return;
    this.pollMs = pollMs;
    if (!this.child) return;
    const wasRunning = !this.paused;
    this.stop();
    this.stopping = false;
    if (wasRunning) this.start();
  }

  /**
   * 붙잡고 있던 구간을 놓는다.
   *
   * 백업 복원·정리처럼 밖에서 활동 기록을 바꾸면, 추적기가 들고 있던 행 id 가
   * 사라졌을 수 있다. 그대로 두면 이후의 UPDATE 가 아무 데도 닿지 않아 기록이 조용히 멈춘다.
   * 다음 샘플에서 다시 이어붙이도록 상태만 비운다 — 기록 자체는 건드리지 않는다.
   */
  releaseOpenSegment() {
    this.open = null;
    this.adoptOnNextOpen = true;
  }

  stop() {
    this.stopping = true;
    this.#releaseLock();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.#closeSegment(Date.now());
    if (this.child) {
      try { this.child.kill(); } catch { /* 이미 종료됨 */ }
      this.child = null;
    }
    this.startedAt = null;
  }

  pause() {
    this.paused = true;
    this.#closeSegment(Date.now());
    setSetting('tracker_paused', '1');
  }

  resume() {
    this.paused = false;
    this.lastSampleAt = 0; // 일시정지 구간을 공백으로 처리
    setSetting('tracker_paused', '0');
    if (!this.child) this.start();
    // 사용자가 일부러 멈춘 구간은 이어붙이지 않는다 — 멈춘 동안은 기록이 없는 게 맞다.
    this.adoptOnNextOpen = false;
  }

  /**
   * 프로브가 죽었을 때. 검사에서 직접 부를 수 있도록 열어 둔다 —
   * 실제로 PowerShell 을 죽여 가며 재시작 간격을 재 볼 수는 없기 때문.
   */
  onExit(code) {
    this.child = null;
    this.#closeSegment(Date.now());
    if (this.stopping) return;
    this.restarts++;
    this.lastError = `프로브가 종료되었습니다 (code ${code}). 재시작합니다.`;

    // 지수 백오프 — 반복 실패 시 CPU 를 태우지 않게.
    //
    // 다만 **한동안 멀쩡히 돌았다면 처음부터 다시 센다.** 예전에는 누적 재시작 횟수로
    // 계산해서, 아침에 다섯 번 죽은 기계는 저녁에 한 번 죽어도 30초를 기다렸다.
    // 그 30초는 기록에 그대로 구멍으로 남는데, 그날 아침 일과는 아무 상관이 없다.
    // 보고용 누적 횟수(`restarts`)는 그대로 두고, 대기 시간 계산만 따로 센다.
    const healthyMs = this.startedAt ? Date.now() - this.startedAt : 0;
    if (healthyMs > HEALTHY_RUN_MS) this.backoffStep = 0;
    this.backoffStep = (this.backoffStep || 0) + 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.backoffStep, 5));
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (!this.stopping) this.start();
    }, delay);
    this.restartTimer.unref?.();
  }

  /**
   * 프로브가 흘려보낸 stdout 조각을 받아 샘플로 바꾼다. 검사에서 직접 부를 수 있도록 열어 둔다.
   *
   * 여기가 이 도구에서 가장 조용히 깨지기 쉬운 자리다 — 파이프는 줄 단위로 오지 않는다.
   * 한 줄이 두 조각으로 잘려 오거나 한 조각에 여러 줄이 들어 있는데, 잘못 다루면
   * 샘플이 통째로 사라지고 화면에는 "기록이 없네" 로만 보인다.
   */
  onChunk(chunk) {
    this.buffer += chunk;
    // 폭주 방지: 한 줄이 비정상적으로 길면 버린다.
    if (this.buffer.length > 1_000_000) this.buffer = '';
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let sample;
      try {
        sample = JSON.parse(line);
      } catch {
        continue;
      }
      if (sample.ready) continue;
      try {
        this.ingest(sample);
      } catch (err) {
        this.lastError = `샘플 처리 오류: ${err.message}`;
      }
    }
  }

  /**
   * 샘플 한 건 반영. 테스트에서 직접 호출할 수 있도록 public.
   * @param {{t:number, title:string, proc:string, app:string, idleMs:number}} sample
   */
  ingest(sample) {
    if (this.paused) return;
    const now = Number(sample.t) || Date.now();
    const idleMs = Math.max(0, Number(sample.idleMs) || 0);

    // 폴링 공백(절전/중단) 감지 — 공백 구간은 기록하지 않는다.
    if (this.lastSampleAt && now - this.lastSampleAt > this.pollMs * 3) {
      this.#closeSegment(this.lastSampleAt);
    }
    this.lastSampleAt = now;
    this.sampleCount++;
    // 살아 있다는 표시. 매 폴링마다 쓰면 디스크가 아깝고, 안 쓰면 잠금이 낡아 버린다.
    if (Date.now() - (this.lastLockAt || 0) > LOCK_WRITE_MS) this.#writeLock();

    const lastInput = now - idleMs;
    const isIdle = idleMs >= this.idleThresholdMs || isAway(sample);

    if (isIdle) {
      if (!this.open || !this.open.idle) {
        this.#closeSegment(lastInput);
        this.#openSegment({ app: '(자리비움)', proc: '', title: '' }, lastInput, true);
      }
      this.#splitAtDayBoundary(now);
      this.#extend(now);
      return;
    }

    const app = sanitizeTitle(sample.app || sample.proc || 'Unknown').slice(0, LIMITS.ACTIVITY_APP);
    const proc = String(sample.proc || '').slice(0, LIMITS.ACTIVITY_APP);
    const title = this.captureTitles ? sanitizeTitle(sample.title).slice(0, LIMITS.ACTIVITY_TITLE) : '';

    if (this.open && this.open.idle) {
      // 유휴 종료 시점 = 마지막 입력 시각
      this.#closeSegment(lastInput);
      this.#openSegment({ app, proc, title }, lastInput, false);
      this.#extend(now);
      return;
    }

    if (!this.open || this.open.app !== app || this.open.title !== title) {
      this.#closeSegment(now);
      this.#openSegment({ app, proc, title }, now, false);
    }

    this.#splitAtDayBoundary(now);
    this.#extend(now);
  }

  /** 업무일 경계를 넘으면 세그먼트를 쪼갠다 — 일별 집계가 정확해지도록. */
  #splitAtDayBoundary(now) {
    if (!this.open) return;
    const [, dayEnd] = dayRange(this.open.day);
    if (now < dayEnd) return;
    const meta = { app: this.open.app, proc: this.open.proc, title: this.open.title };
    const wasIdle = Boolean(this.open.idle);
    this.#closeSegment(dayEnd - 1, { keepShort: true });
    this.#openSegment(meta, dayEnd, wasIdle);
  }

  /**
   * 서버를 다시 켰을 때 직전 실행이 남긴 구간을 이어받는다.
   *
   * 재시작 직후 첫 샘플은 대개 "몇 시간째 자리비움"으로 들어온다. 그대로 새 행을 만들면
   * 같은 시간대가 실행 횟수만큼 중복 기록되어 하루 합계가 부풀어 오른다.
   * 그래서 부팅 후 첫 구간에 한해, 방금 이어지는 같은 성격의 마지막 행이 있으면 그것을 잇는다.
   *
   * 부팅 직후에만 시도한다 — 평상시에는 업무일 경계 분할처럼 "일부러 같은 내용으로
   * 새 구간을 여는" 경우가 있어서, 무조건 이어붙이면 그쪽이 망가진다.
   */
  #adoptLastSegment(meta, at, idle) {
    if (!this.adoptOnNextOpen) return false;
    this.adoptOnNextOpen = false;

    // id 가 아니라 "가장 최근까지 기록되던" 행을 찾는다.
    // 업무일 경계에서 구간을 쪼개면 전날 조각이 나중에 삽입되어 id 가 더 크다.
    // id 로 고르면 몇 시간 전에 끝난 전날 행을 집어 이어붙이기가 실패한다.
    const last = get('SELECT * FROM activity ORDER BY ended_at DESC, id DESC LIMIT 1');
    if (!last) return false;

    const sameKind = last.idle === (idle ? 1 : 0)
      && last.app === meta.app
      && last.title === (meta.title || '');
    if (!sameKind) return false;

    // 판단 기준은 "새 구간의 시작점"이 아니라 "직전 기록이 방금 끝났는가"다.
    // 자리비움은 마지막 입력 시각으로 소급해 열리므로 시작점이 몇 시간 전일 수 있고,
    // 업무일 경계에서 잘린 뒤라면 기존 행의 시작이 오히려 더 나중이다.
    //
    // 자리비움은 재시작에 걸쳐 이어지는 것이 정상이고 그 사이 공백도 어차피 자리비움이라
    // 넉넉히 허용한다. 반대로 활동 구간은 짧게 살다 가므로, 거의 즉시 재시작한 경우에만 잇는다.
    const sinceLast = (this.lastSampleAt || at) - last.ended_at;
    const grace = idle ? ADOPT_IDLE_GRACE_MS : this.pollMs * 3;
    if (sinceLast < 0 || sinceLast > grace) return false;

    this.open = {
      id: last.id,
      app: last.app,
      proc: last.exe,
      title: last.title,
      started_at: last.started_at,
      day: last.day,
      idle: last.idle,
      category_id: last.category_id,
    };
    this.emit('segment-open', this.open);
    return true;
  }

  /**
   * 똑같은 시작 시각·내용의 구간이 이미 있으면 그것을 잇는다.
   *
   * 자리비움은 "마지막 입력 시각" 으로 소급해 열린다. 그래서 자리를 비운 채 서버를
   * 여러 번 켜면 매번 **똑같은 시작 시각**의 자리비움 행이 하나씩 생긴다 —
   * 실제 기록에서 00:47:54 로 시작하는 자리비움이 열 줄 쌓여 있었다.
   * 하루 합계가 실행 횟수만큼 부풀어 오르는데, 화면에는 그냥 "자리비움이 길었다" 로 보인다.
   *
   * 재시작 이어받기(#adoptLastSegment)는 공백이 30분을 넘으면 포기하도록 해 두었는데,
   * 하필 그 조건이 이 상황과 정확히 겹친다 — 오래 자리를 비울수록 중복이 확실해진다.
   * 그래서 시각과 내용이 같으면 공백과 상관없이 잇는다. 같은 순간에 같은 내용으로
   * 두 번 열리는 일은 애초에 있을 수 없으므로, 잘못 이을 위험이 없다.
   *
   * "같은 시각" 은 밀리초까지 같다는 뜻이 아니다. 소급 시점은 `지금 - 유휴시간` 으로 구하는데
   * GetLastInputInfo 의 해상도와 폴링 시점 때문에 매번 몇 밀리초씩 흔들린다.
   * 실제 기록에서 2~130ms 씩 어긋난 여덟 줄이 쌓여 있었고, 정확히 일치하는지만 보던
   * '중복 기록' 점검은 그것을 하나도 잡지 못했다. 그래서 넉넉히 2초 안이면 같은 것으로 본다 —
   * 3초 미만의 구간은 어차피 노이즈로 버리므로 서로 다른 구간을 잘못 이을 여지가 없다.
   */
  #adoptTwin(meta, at, idle) {
    const twin = get(
      `SELECT * FROM activity
       WHERE started_at BETWEEN ? AND ? AND app = ? AND title = ? AND idle = ?
       ORDER BY ended_at DESC, id DESC LIMIT 1`,
      at - TWIN_TOLERANCE_MS, at + TWIN_TOLERANCE_MS,
      meta.app, meta.title || '', idle ? 1 : 0,
    );
    if (!twin) return false;
    this.open = {
      id: twin.id,
      app: twin.app,
      proc: twin.exe,
      title: twin.title,
      started_at: twin.started_at,
      day: twin.day,
      idle: twin.idle,
      category_id: twin.category_id,
    };
    this.emit('segment-open', this.open);
    return true;
  }

  #openSegment(meta, at, idle) {
    if (this.#adoptLastSegment(meta, at, idle)) return;
    if (this.#adoptTwin(meta, at, idle)) return;

    const day = dayKey(at);
    const categoryId = idle ? null : categorize(meta);
    const res = run(
      `INSERT INTO activity(app, title, exe, started_at, ended_at, seconds, idle, category_id, day)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      meta.app, meta.title || '', meta.proc || '', at, at, idle ? 1 : 0, categoryId, day,
    );
    this.open = {
      id: Number(res.lastInsertRowid),
      app: meta.app,
      proc: meta.proc || '',
      title: meta.title || '',
      started_at: at,
      day,
      idle: idle ? 1 : 0,
      category_id: categoryId,
    };
    this.emit('segment-open', this.open);
  }

  #extend(at) {
    if (!this.open) return;
    const end = Math.max(at, this.open.started_at);
    const seconds = Math.round((end - this.open.started_at) / 1000);
    const res = run(
      'UPDATE activity SET ended_at = ?, seconds = ? WHERE id = ?',
      end, seconds, this.open.id,
    );
    // 붙잡고 있던 행이 밖에서 사라졌다면(정리·복원·수동 삭제) 이 UPDATE 는 아무 데도 닿지 않는다.
    // 그대로 두면 기록이 조용히 멈추므로, 상태를 비워 다음 샘플에서 다시 열게 한다.
    if (!Number(res.changes)) {
      this.open = null;
      this.adoptOnNextOpen = true;
    }
  }

  #closeSegment(at, { keepShort = false } = {}) {
    if (!this.open) return;
    const end = Math.max(at, this.open.started_at);
    const seconds = Math.round((end - this.open.started_at) / 1000);
    if (seconds < MIN_SEGMENT_S && !this.open.idle && !keepShort) {
      run('DELETE FROM activity WHERE id = ?', this.open.id);
    } else {
      run('UPDATE activity SET ended_at = ?, seconds = ? WHERE id = ?', end, seconds, this.open.id);
      this.emit('segment-close', { ...this.open, ended_at: end, seconds });
    }
    this.open = null;
  }
}

export const tracker = new Tracker();

/**
 * 추적기 자가 진단.
 *
 * "기록이 안 쌓이는데 왜인지 모르겠다"가 이 도구에서 가장 답답한 상황이다.
 * 프로브를 딱 한 번 돌려 보고, 어디서 막혔는지(실행 정책, PowerShell 부재, 권한)
 * 사람이 읽을 수 있는 문장으로 돌려준다.
 */
export function diagnose({ timeoutMs = 12_000 } = {}) {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('플랫폼', process.platform === 'win32', `${process.platform} (자동 추적은 Windows 전용)`);
  add('프로브 스크립트', fs.existsSync(PROBE), PROBE);

  if (process.platform !== 'win32' || !fs.existsSync(PROBE)) {
    return Promise.resolve({ ok: false, checks, sample: null });
  }

  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (sample) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child?.kill(); } catch { /* 이미 종료됨 */ }

      const got = Boolean(sample);
      add('프로브 응답', got, got
        ? `포그라운드: ${sample.app || '(알 수 없음)'} · 마지막 입력 ${Math.round((sample.idleMs || 0) / 1000)}초 전`
        : (stderr.trim().slice(0, 300) || '샘플을 받지 못했습니다'));

      if (got) {
        add('창 제목 읽기', typeof sample.title === 'string',
          sample.title ? `"${sanitizeTitle(sample.title).slice(0, 60)}"` : '(제목 없는 창)');
        add('유휴 감지', Number.isFinite(sample.idleMs), `${sample.idleMs}ms`);

        // 잠금 화면·화면보호기에서 진단을 돌리면 프로브는 멀쩡한데 기록은 안 쌓인다.
        // "기록이 안 쌓입니다" 를 확인하러 온 사람이 여기서 헤매지 않도록 짚어 준다.
        if (isAway(sample)) {
          add('지금 상태', true,
            '잠금 화면이거나 창을 알아낼 수 없는 상태입니다 — 이 시간은 자리비움으로 기록됩니다. '
            + '평소 쓰는 창을 띄운 채 다시 눌러 보세요.');
        }
      }

      resolve({
        ok: checks.every((c) => c.ok),
        checks,
        sample: sample || null,
        stderr: stderr.trim().slice(0, 1000) || null,
      });
    };

    const timer = setTimeout(() => {
      add('시간 초과', false,
        `${timeoutMs / 1000}초 안에 응답이 없습니다. PowerShell 실행 정책이나 보안 소프트웨어가 막고 있을 수 있습니다.`);
      finish(null);
    }, timeoutMs);

    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', PROBE, '-IntervalMs', '1000',
      ], { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      add('PowerShell 실행', false, err.message);
      finish(null);
      return;
    }
    add('PowerShell 실행', true, 'powershell.exe 를 띄웠습니다');

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.ready) continue;
          finish(parsed);
          return;
        } catch { /* 아직 줄이 덜 왔다 */ }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => {
      add('PowerShell 실행', false, err.message);
      finish(null);
    });
    child.on('exit', (code) => {
      if (!settled) {
        add('프로브 종료', false, `프로브가 샘플 없이 종료되었습니다 (code ${code})`);
        finish(null);
      }
    });
  });
}

/** 서버 시작 시 마지막 상태를 복원한다. */
export function bootTracker() {
  // 테스트나 헤드리스 실행에서 프로브 프로세스를 띄우지 않기 위한 탈출구.
  if (process.env.CADENCE_NO_TRACKER === '1') return tracker.status();
  tracker.applySettings({
    pollMs: Number(setting('tracker_poll_ms', String(TRACKER_POLL_MS))),
    idleThresholdS: Number(setting('tracker_idle_s', String(IDLE_THRESHOLD_S))),
  });
  const wasPaused = setting('tracker_paused', '0') === '1';
  const autostart = setting('tracker_autostart', '1') !== '0';
  if (wasPaused) tracker.paused = true;
  if (autostart && !wasPaused) tracker.start();
  return tracker.status();
}

/** 마지막으로 기록된 세그먼트(디버그/상태 표시용). */
export function lastSegment() {
  return get('SELECT * FROM activity ORDER BY id DESC LIMIT 1') || null;
}
