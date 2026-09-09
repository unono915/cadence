import { h, mount } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { toast, confirmDialog, openModal, clickable } from '../lib/ui.js';
import { dur, dayDiff, shiftDay } from '../lib/format.js';
import { store, loadBase, refreshTracker, applyTheme } from '../lib/store.js';
import { LIMITS } from '../lib/limits.js';

export async function render(root) {
  // 무결성 점검은 기록 전체를 시간 순으로 훑는다. 몇 달치가 쌓이면 1초 가까이 걸리는데,
  // 그것 때문에 설정 화면 전체가 멈춰 있으면 "느린 화면"으로 기억된다.
  // 나머지를 먼저 그리고, 결과가 오면 그 자리만 채운다.
  const integrityBox = h('div');

  async function load() {
    const [settings, rules, categories, tracker, storage, errors] = await Promise.all([
      api.get('/api/settings'),
      api.get('/api/rules'),
      api.get('/api/categories'),
      api.get('/api/tracker'),
      api.get('/api/storage'),
      api.get('/api/errors'),
    ]);
    draw({ settings, rules, categories, tracker, storage, errors });
    loadIntegrity();
  }

  async function loadIntegrity() {
    integrityBox.replaceChildren(
      h('div.muted', { style: { fontSize: '12px', marginTop: '10px' } }, '기록을 점검하는 중…'),
    );
    let integrity;
    try {
      integrity = await api.get('/api/storage/integrity');
    } catch {
      integrityBox.replaceChildren();
      return;
    }
    // 문제가 없으면 아무것도 남기지 않는다 — 이상 없는 화면에 경고 자리를 만들지 않는다.
    integrityBox.replaceChildren(integrity.ok ? '' : integrityCard(integrity));
  }

  /**
   * @returns {Promise<boolean>} 저장에 성공했는지. 실패하면 화면을 되돌려야 한다.
   *
   * 예전에는 그냥 던지고 말았다. 그러면 api 계층이 오류 토스트는 띄우지만 입력칸은
   * 방금 친 값을 그대로 들고 있는다 — 저장되지 않은 숫자가 화면에 남아, 다음에 들어오면
   * 아무 말 없이 옛 값으로 돌아가 있다. 어느 쪽이 진짜인지 알 방법이 없다.
   */
  async function save(patch) {
    try {
      await api.patch('/api/settings', patch);
    } catch {
      return false; // 메시지는 api 계층이 이미 띄웠다.
    }
    await loadBase();
    // 업무일 경계를 바꾸면 서버가 지난 기록의 날짜를 전부 다시 매긴다.
    // 어제까지의 숫자가 달라 보일 수 있으므로, 저장했다는 말만 하고 넘어가면 안 된다.
    toast(
      'day_start_hour' in patch
        ? '업무일 시작 시각을 바꿨습니다 — 지난 기록의 날짜도 새 기준으로 다시 매겼습니다'
        : '저장했습니다',
      'ok',
      'day_start_hour' in patch ? 6000 : undefined,
    );
    load();
    return true;
  }

  function numberField(label, key, settings, { min, max, hint } = {}) {
    const input = h('input', { type: 'number', value: settings[key], min, max });
    input.addEventListener('change', async () => {
      const previous = String(settings[key]);
      // 서버가 거절하면 방금 친 값을 되돌린다. 그대로 두면 저장되지도 않은 숫자가
      // 화면에 남아 있다가, 다음에 들어오면 아무 말 없이 옛 값으로 돌아가 있다.
      if (!(await save({ [key]: Number(input.value) }))) input.value = previous;
    });
    return h('label.field', label, input, hint ? h('span', { style: { fontSize: '11px' } }, hint) : null);
  }

  /** @param {(nowOn: boolean) => void} [after] 저장이 끝난 뒤 할 일 */
  function toggle(label, key, settings, hint, after) {
    const on = settings[key] === '1';
    return h('div.row', { style: { justifyContent: 'space-between', gap: '16px', padding: '7px 0' } },
      h('div', h('div', label), hint ? h('div.muted', { style: { fontSize: '12px' } }, hint) : null),
      h('button.btn', {
        class: on ? 'primary' : '',
        'aria-pressed': String(on),
        onclick: async () => { if (await save({ [key]: !on })) await after?.(!on); },
      }, on ? '켜짐' : '꺼짐'),
    );
  }

  function integrityCard(integrity) {
    return h('div.hint', {
      style: {
        marginTop: '12px',
        background: 'color-mix(in srgb, var(--warn) 11%, transparent)',
        borderColor: 'color-mix(in srgb, var(--warn) 30%, transparent)',
        flexDirection: 'column', alignItems: 'stretch',
      },
    },
      h('div.row', h('span.icon', '!'), h('span', { style: { fontWeight: 500 } }, '정리할 기록이 있습니다')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', margin: '6px 0 8px' } },
        integrity.issues.map((i) => h('div', { style: { fontSize: '12px' } },
          `· ${i.label} ${i.count.toLocaleString()}건 — ${i.detail}`)),
      ),
      h('div.row',
        h('button.btn.sm.primary', {
          onclick: async () => {
            const res = await api.post('/api/storage/repair');
            const total = Object.values(res.repaired).reduce((sum, n) => sum + n, 0);
            toast(`${total.toLocaleString()}건을 정리했습니다`, 'ok');
            load();
          },
        }, '정리하기'),
        h('span.muted', { style: { fontSize: '11px' } }, '정리 전에 데이터베이스 사본이 저장됩니다'),
      ),
    );
  }

  function draw({ settings, rules, categories, tracker, storage, errors }) {
    const trackerCard = h('div.card',
      h('h2', '자동 추적'),
      h('div.hint', { style: { marginBottom: '12px' } },
        h('span.icon', '🔒'),
        h('span', '활동 기록은 이 PC 의 SQLite 파일에만 저장됩니다. 서버는 127.0.0.1 에만 바인딩되고, 외부로 아무것도 전송하지 않습니다.'),
      ),
      h('dl.kv', { style: { marginBottom: '12px' } },
        h('dt', '상태'), h('dd', tracker.running ? '동작 중' : tracker.supported ? '정지됨' : '이 플랫폼 미지원'),
        h('dt', '지금'), h('dd', tracker.current ? `${tracker.current.idle ? '자리비움' : tracker.current.app} · ${dur(tracker.current.seconds)}` : '—'),
        h('dt', '수집 샘플'), h('dd.mono', `${tracker.samples}`),
        h('dt', '폴링 주기'), h('dd.mono', `${tracker.pollMs / 1000}초`),
        h('dt', '자리비움 판정'), h('dd.mono', `${tracker.idleThresholdS}초`),
        tracker.lastError ? [h('dt', '최근 오류'), h('dd', { style: { color: 'var(--warn)' } }, tracker.lastError)] : null,
      ),
      h('div.row',
        h('button.btn', {
          class: tracker.running ? '' : 'primary',
          onclick: async () => {
            await api.post(tracker.running ? '/api/tracker/pause' : '/api/tracker/start');
            await refreshTracker();
            load();
          },
        }, tracker.running ? '일시정지' : '시작'),
        h('button.btn', {
          onclick: (e) => runDiagnosis(e.currentTarget),
          title: '프로브를 한 번 돌려 어디서 막혔는지 확인합니다',
        }, '진단'),
      ),
      h('div', { style: { marginTop: '8px' } },
        toggle('창 제목 수집', 'capture_titles', settings,
          '끄면 앱 이름만 기록합니다. 문서·URL 제목이 남지 않아 더 안전하지만 분류 정확도는 떨어집니다.',
          // 끄는 사람이 실제로 신경 쓰는 것은 앞으로가 아니라 **이미 쌓인 쪽**이다.
          // 그 생각을 하고 있는 바로 그 순간에 물어야 한다 — 나중에 설정을 다시 뒤지지 않는다.
          async (nowOn) => {
            if (nowOn || !storage.titled) return;
            if (!(await confirmDialog(
              `앞으로는 창 제목을 남기지 않습니다. 이미 기록된 ${storage.titled.toLocaleString()}건의 제목도 지울까요?`
              + ' 시간·앱·분류는 그대로 남고, 지우기 전에 사본이 저장됩니다.',
              { title: '이미 기록된 제목', okLabel: '지우기', danger: true },
            ))) return;
            await clearTitles(load);
          }),
        toggle('시작 시 자동 실행', 'tracker_autostart', settings, '서버를 켜면 추적기도 함께 시작합니다.'),
        toggle('세션 종료 소리', 'notify_sound', settings, '끄면 브라우저 알림만 뜨고 소리는 나지 않습니다.'),
      ),
      h('div.grid.cols-2', { style: { marginTop: '8px' } },
        numberField('폴링 주기 (ms)', 'tracker_poll_ms', settings, { min: 2000, max: 30000,
          hint: '짧을수록 정밀하지만 기록이 많아집니다. 바꾸면 프로브가 다시 시작됩니다.' }),
        numberField('자리비움 판정 (초)', 'tracker_idle_s', settings, { min: 30, max: 1800,
          hint: '이 시간 동안 입력이 없으면 자리비움으로 봅니다' }),
        numberField('이탈 알림 (초)', 'drift_alert_s', settings, { min: 0, max: 1800,
          hint: '집중 세션 중 방해요소에 이만큼 머물면 알립니다. 0 이면 알리지 않습니다.' }),
      ),
    );

    const targetCard = h('div.card',
      h('h2', '목표와 판정 기준'),
      h('div.grid.cols-2',
        numberField('하루 몰입 목표 (분)', 'analytics_daily_deep_target_min', settings, { min: 30, max: 720 }),
        numberField('하루 집중 세션 목표', 'analytics_daily_focus_target', settings, { min: 1, max: 24 }),
        numberField('몰입 블록 최소 길이 (분)', 'analytics_deep_block_min', settings, { min: 5, max: 120,
          hint: '이 시간 이상 이어져야 하나의 블록으로 셉니다' }),
        numberField('블록 허용 이탈 (초)', 'analytics_deep_tolerance_sec', settings, { min: 30, max: 900,
          hint: '이보다 짧게 다른 창을 봤다면 블록이 유지됩니다' }),
        numberField('기본 집중 시간 (분)', 'default_focus_min', settings, { min: 5, max: 180 }),
        numberField('기본 휴식 시간 (분)', 'default_break_min', settings, { min: 1, max: 60 }),
        numberField('업무일 시작 시각', 'day_start_hour', settings, { min: 0, max: 23,
          hint: '새벽 작업이 전날로 잡히도록 하는 기준. 기본 4시' }),
        numberField('하루 마무리 알림 시각', 'day_review_hour', settings, { min: 0, max: 23,
          hint: '이 시각이 지나면 하루에 한 번 마무리를 권합니다' }),
      ),
      toggle('하루 마무리 알림', 'day_review_reminder', settings,
        '끄면 알리지 않습니다. 마무리는 "오늘" 화면의 버튼으로 언제든 할 수 있습니다.'),
    );

    const themeSel = h('select',
      ['auto', 'dark', 'light'].map((t) => h('option', { value: t, selected: settings.theme === t },
        { auto: '시스템 설정', dark: '어둡게', light: '밝게' }[t])),
    );
    themeSel.addEventListener('change', async () => {
      const previous = settings.theme;
      applyTheme(themeSel.value);
      if (!(await save({ theme: themeSel.value }))) {
        // 저장이 안 됐으면 보이는 테마도 되돌린다 — 화면과 저장된 값이 어긋나면
        // 다음 새로고침에 이유 없이 색이 바뀐 것처럼 보인다.
        themeSel.value = previous;
        applyTheme(previous);
      }
    });

    const appearance = h('div.card',
      h('h2', '표시'),
      h('label.field', '테마', themeSel),
    );

    const catCard = h('div.card',
      h('h2', '카테고리',
        h('div.row',
          h('span.sub', `${categories.length}개`),
          h('button.btn.sm', { onclick: () => openCategoryForm(null, load) }, '＋ 추가'),
        ),
      ),
      h('div.row.wrap',
        categories.map((c) => h('span.tag', clickable({
          title: `${KIND_LABELS[c.kind] || c.kind} · 규칙 ${c.rule_count}개 · 기록 ${c.activity_count}건 — 눌러서 수정`,
          style: { padding: '4px 10px', cursor: 'pointer' },
        }, () => openCategoryForm(c, load), `${c.name} 카테고리 수정`),
          h('span.swatch', { style: { background: c.color } }),
          c.name,
          h('span.muted', { style: { marginLeft: '3px', fontSize: '10px' } }, KIND_LABELS[c.kind] || c.kind),
        )),
      ),
      h('div.muted', { style: { fontSize: '12px', marginTop: '10px' } },
        '분석은 카테고리의 이름이 아니라 종류(몰입/얕은 일/소통/회의/방해)를 기준으로 계산합니다. '
        + '"고객 응대" 같은 자기 업무 이름을 만들고 종류만 맞춰 주면 됩니다.'),
    );

    const ruleCard = h('div.card',
      h('h2', '분류 규칙',
        h('div.row',
          h('span.sub', `${rules.length}개 · 우선순위 숫자가 작을수록 먼저 검사`),
          h('button.btn.sm', { onclick: () => openRuleForm(null, categories, load) }, '＋ 규칙'),
        ),
      ),
      h('div.table-scroll', h('table.data',
        h('thead', h('tr', h('th', '우선'), h('th', '대상'), h('th', '패턴'), h('th', '카테고리'), h('th', ''))),
        h('tbody', rules.map((r) => h('tr', clickable({
          style: { cursor: 'pointer' },
          title: '눌러서 수정',
        }, () => openRuleForm(r, categories, load), `규칙 "${r.pattern}" 수정`),
          h('td.mono.muted', String(r.priority)),
          h('td', r.field === 'app' ? '앱' : '창 제목'),
          h('td.mono', { style: { maxWidth: '260px', wordBreak: 'break-all' } },
            r.pattern,
            r.is_regex ? h('span.muted', { style: { marginLeft: '5px', fontSize: '10px' } }, '정규식') : null),
          h('td', h('span.tag', h('span.swatch', { style: { background: r.category_color } }), r.category_name)),
          h('td', h('button.btn.ghost.sm.danger', {
            'aria-label': `${r.pattern} 규칙 삭제`,
            onclick: async (e) => {
              e.stopPropagation();
              const res = await api.del(`/api/rules/${r.id}`);
              toast(res.updated
                ? `규칙을 지우고 기존 기록 ${res.updated.toLocaleString()}건을 다시 분류했습니다`
                : '규칙을 지웠습니다', 'ok');
              load();
            },
          }, '삭제')),
        ))),
      )),
      h('div.row', { style: { marginTop: '12px' } },
        h('button.btn', {
          onclick: async () => {
            const res = await api.post('/api/rules/recategorize');
            toast(res.updated
              ? `${res.updated.toLocaleString()}건의 분류가 바뀌었습니다`
              : '바뀐 분류가 없습니다 — 이미 규칙대로 정리되어 있습니다', 'ok');
            // 카테고리 칩에 붙은 "기록 N건" 이 방금 바뀐 값이다. 다시 읽지 않으면
            // "1,204건이 바뀌었습니다" 라는 말 바로 옆에 옛 숫자가 그대로 남는다.
            if (res.updated) load();
          },
        }, '전체 다시 분류'),
        h('span.muted', { style: { fontSize: '12px' } }, '타임라인에서 기록을 눌러 "이 앱을 항상 이렇게"로 규칙을 추가할 수 있습니다'),
      ),
    );

    const dataCard = h('div.card',
      h('h2', '데이터', h('span.sub', formatBytes(storage.db_bytes))),
      h('dl.kv', { style: { marginBottom: '12px' } },
        h('dt', '활동 기록'), h('dd.mono',
          `${storage.activity.n.toLocaleString()}건${storage.activity.first_day ? ` · ${storage.activity.first_day} ~ ${storage.activity.last_day}` : ''}`),
        h('dt', '세션 / 태스크'), h('dd.mono', `${storage.sessions.n} / ${storage.tasks.n}`),
        h('dt', '파일'), h('dd', { style: { wordBreak: 'break-all', fontSize: '12px' } }, storage.db_path),
        h('dt', '마지막 전체 백업'), lastExportCell(storage.last_export_at),
      ),
      h('div.row.wrap',
        h('button.btn', { onclick: () => downloadUrl('/api/export/all.json', `cadence-backup-${store.today}.json`) },
          '전체 백업 (JSON)'),
        h('button.btn', {
          onclick: () => downloadUrl(
            `/api/export/activity.csv?from=${shiftDay(store.today, -30)}&to=${store.today}`,
            'cadence-activity-30d.csv',
          ),
        }, '최근 30일 CSV'),
        h('button.btn', { onclick: () => openImport(load) }, '백업 가져오기'),
        h('button.btn', { onclick: () => openPrune(storage, load) }, '오래된 기록 정리'),
        storage.titled
          ? h('button.btn', {
              onclick: () => forgetTitles(storage.titled, load),
              title: '이미 기록된 창 제목만 지웁니다. 시간·앱·분류는 그대로 남습니다.',
            }, '기록된 창 제목 지우기')
          : null,
      ),
      integrityBox,
      storage.snapshots.length
        ? h('div', { style: { marginTop: '12px' } },
            h('div.muted', { style: { fontSize: '12px', marginBottom: '4px' } },
              '자동 안전 사본 (가져오기·정리 직전에 남긴 것, 최근 5개 유지)'),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } },
              storage.snapshots.map((sn) => h('div.muted.mono', { style: { fontSize: '11px' } },
                `${sn.file} · ${formatBytes(sn.bytes)}`)),
            ),
          )
        : null,
      h('div.muted', { style: { fontSize: '12px', marginTop: '10px' } },
        '데이터베이스 파일을 그대로 복사해도 됩니다. 가져오기는 덮어쓰기 전에 자동으로 사본을 남깁니다.'),
    );

    const shortcuts = h('div.card',
      h('h2', '단축키'),
      h('dl.kv',
        h('dt.mono', '1–5'), h('dd', '화면 이동'),
        h('dt.mono', 'N'), h('dd', '빠른 태스크 추가'),
        h('dt.mono', 'F'), h('dd', '집중 세션 시작 / 종료'),
        h('dt.mono', 'I'), h('dd', '방해 1회 기록'),
        h('dt.mono', '← →'), h('dd', '날짜 이동'),
        h('dt.mono', 'Esc'), h('dd', '창 닫기'),
      ),
    );

    // 오류가 있을 때만 보여 준다. 콘솔 없이 자동 실행하면 이곳이 유일한 창구다.
    const errorCard = errors.errors.length
      ? h('div.card', { style: { borderColor: 'color-mix(in srgb, var(--bad) 35%, transparent)' } },
          h('h2', '최근 서버 오류',
            h('div.row',
              h('span.sub', `${errors.errors.length}건`),
              h('button.btn.sm.ghost', {
                onclick: async () => { await api.del('/api/errors'); toast('오류 기록을 지웠습니다', 'ok'); load(); },
              }, '지우기'),
            ),
          ),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
            errors.errors.slice(0, 8).map((e) => h('div', { style: { fontSize: '12px' } },
              h('span.mono.muted', new Date(e.at).toLocaleString('ko-KR')),
              h('span', { style: { marginLeft: '8px', color: 'var(--text-dim)' } }, `[${e.context}]`),
              h('div', { style: { color: 'var(--bad)', wordBreak: 'break-word' } }, e.message),
            )),
          ),
          h('div.muted', { style: { fontSize: '11px', marginTop: '9px', wordBreak: 'break-all' } },
            `전체 기록: ${errors.path}`),
        )
      : null;

    mount(root,
      errorCard,
      h('div.grid.cols-2', trackerCard, h('div.grid', { style: { gridTemplateColumns: '1fr' } }, appearance, shortcuts)),
      targetCard,
      h('div.grid.cols-2', catCard, dataCard),
      ruleCard,
    );
  }

  await load();
  return { refresh: load };
}

/**
 * 마지막으로 전체 백업(JSON)을 받아 간 때.
 *
 * 자동 사본은 데이터베이스와 **같은 디스크**에 있다 — 디스크가 죽으면 함께 사라진다.
 * 진짜 백업은 이 파일을 다른 곳에 두는 것뿐인데, 그건 사용자가 기억해야 하는 일이고
 * 사람은 기억하지 않는다. 잔소리를 하려는 게 아니라 "한 번도 없음" 과 "그저께" 는
 * 완전히 다른 상태이고, 지금까지는 그 둘을 구별할 방법이 화면에 없었다.
 */
function lastExportCell(at) {
  if (!at) {
    return h('dd', { style: { color: 'var(--warn)' } },
      '한 번도 없습니다 — 자동 사본은 같은 디스크에 있어 디스크가 죽으면 함께 사라집니다');
  }
  // 달력 날짜로 센다 — 어제 저녁에 받아 간 것을 오늘 아침에 "오늘" 이라고 하면 안 된다.
  const days = dayDiff(at, Date.now());
  const when = days === 0 ? '오늘' : days === 1 ? '어제' : `${days}일 전`;
  const stale = days >= 14;
  return h('dd', { style: stale ? { color: 'var(--warn)' } : null },
    when,
    stale ? ' — 다른 곳에 한 벌 받아 두세요' : null);
}

const KIND_LABELS = {
  deep: '몰입', shallow: '얕은 일', comms: '소통', meeting: '회의',
  break: '휴식', distraction: '방해', other: '미분류',
};

function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function downloadUrl(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
}

/** 백업 JSON 을 골라 미리 확인한 뒤 복원한다. */
function openImport(onDone) {
  openModal((close) => {
    const file = h('input', { type: 'file', accept: '.json,application/json' });
    const summary = h('div.muted', { style: { fontSize: '12px' } }, '파일을 고르면 내용을 먼저 확인해 드립니다.');
    const modeSel = h('select',
      h('option', { value: 'replace' }, '덮어쓰기 — 기존 데이터를 지우고 백업으로 대체'),
      h('option', { value: 'merge' }, '합치기 — 없는 항목만 추가'),
    );
    const okBtn = h('button.btn.primary', { disabled: true }, '복원');
    let payload = null;

    file.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      // 몇 달치 기록이면 백업이 수십 MB 다. JSON.parse 가 도는 동안 화면은 그대로 멈추므로,
      // 아무 말도 없으면 고장난 것처럼 보인다.
      summary.textContent = `읽는 중… (${(f.size / 1024 / 1024).toFixed(1)} MB)`;
      summary.style.color = 'var(--text-dim)';
      okBtn.disabled = true;
      try {
        payload = JSON.parse(await f.text());
      } catch {
        summary.textContent = 'JSON 을 읽을 수 없습니다.';
        summary.style.color = 'var(--bad)';
        okBtn.disabled = true;
        return;
      }
      const counts = ['activity', 'tasks', 'focus_sessions', 'projects', 'notes', 'rules']
        .filter((k) => Array.isArray(payload[k]))
        .map((k) => `${k} ${payload[k].length}`);
      if (!counts.length) {
        summary.textContent = 'Cadence 백업 파일이 아닌 것 같습니다.';
        summary.style.color = 'var(--bad)';
        okBtn.disabled = true;
        return;
      }
      summary.textContent = `${payload.exported_at ? `${payload.exported_at.slice(0, 10)} 백업 · ` : ''}${counts.join(' · ')}`;
      summary.style.color = 'var(--text-dim)';
      okBtn.disabled = false;
    });

    okBtn.onclick = async () => {
      const mode = modeSel.value;
      if (mode === 'replace' && !(await confirmDialog(
        '지금 있는 모든 기록을 지우고 백업 내용으로 바꿉니다. 되돌리기 위한 사본은 자동으로 남습니다. 진행할까요?',
        { title: '덮어쓰기 확인', danger: true, okLabel: '덮어쓰기' },
      ))) return;

      okBtn.disabled = true;
      okBtn.textContent = '복원 중…';
      try {
        const res = await api.post('/api/import', { data: payload, mode });
        const total = Object.values(res.counts).reduce((s, n) => s + n, 0);
        close();
        toast(
          res.skipped
            ? `${total.toLocaleString()}건을 복원했습니다 (이미 있어서 건너뛴 ${res.skipped.toLocaleString()}건)`
            : `${total.toLocaleString()}건을 복원했습니다`,
          'ok', 6000,
        );
        await loadBase();
        onDone?.();
      } finally {
        okBtn.disabled = false;
        okBtn.textContent = '복원';
      }
    };

    return {
      title: '백업 가져오기',
      body: [
        h('div.hint', h('span.icon', '!'),
          h('span', '복원 직전에 현재 데이터베이스 사본이 자동으로 저장됩니다. 무언가 잘못되면 그 파일로 되돌릴 수 있습니다.')),
        h('label.field', '백업 파일 (cadence-backup-*.json)', file),
        summary,
        h('label.field', '방식', modeSel),
      ],
      footer: [h('button.btn', { onclick: close }, '취소'), okBtn],
    };
  });
}

/**
 * 이미 기록된 창 제목을 지운다.
 *
 * '창 제목 수집' 을 끄는 것은 **앞으로**만 막는다. 정작 끄는 사람이 걱정하는 것은
 * 이미 남아 있는 쪽인 경우가 많다 — 문서 이름이나 거래처 이름이 창 제목에 그대로
 * 들어가 있다는 걸 뒤늦게 알아차리고 끄기 때문이다. 지울 방법이 없으면 남은 선택은
 * 데이터베이스를 통째로 버리는 것뿐이고, 그러면 몇 달치 기록을 함께 잃는다.
 */
async function clearTitles(onDone) {
  const res = await api.post('/api/storage/forget-titles');
  toast(res.cleared
    ? `${res.cleared.toLocaleString()}건의 창 제목을 지웠습니다 — 시간·앱·분류는 그대로입니다`
    : '지울 제목이 없습니다', 'ok', 6000);
  onDone?.();
}

async function forgetTitles(count, onDone) {
  if (!(await confirmDialog(
    `기록 ${count.toLocaleString()}건에 남아 있는 창 제목을 지웁니다. 시간·앱·분류는 그대로 남고`
    + ' 숫자도 달라지지 않습니다. 다만 창 제목으로 판단하는 규칙은 지난 기록에 다시'
    + ' 적용할 수 없게 됩니다. 되돌릴 수 없으며, 지우기 전에 사본이 저장됩니다.',
    { title: '기록된 창 제목 지우기', danger: true, okLabel: '지우기' },
  ))) return;
  await clearTitles(onDone);
}

/** 오래된 활동 기록 정리 — 태스크·세션·노트는 남긴다. */
function openPrune(storage, onDone) {
  openModal((close) => {
    const keep = h('select',
      [90, 180, 365, 730].map((d) => h('option', { value: d, selected: d === 365 }, `최근 ${d}일만 남기기`)),
    );
    const preview = h('div.muted', { style: { fontSize: '12px' } });

    const cutoff = () => shiftDay(store.today, -Number(keep.value));
    const paint = () => {
      preview.textContent = `${cutoff()} 이전의 활동 기록이 지워집니다. 현재 보관 범위: ${
        storage.activity.first_day || '없음'} ~ ${storage.activity.last_day || '없음'} (${storage.activity.n.toLocaleString()}건)`;
    };
    keep.addEventListener('change', paint);
    paint();

    return {
      title: '오래된 기록 정리',
      body: [
        h('div.hint', h('span.icon', 'i'),
          h('span', '활동 기록만 지웁니다. 태스크·집중 세션·노트·리포트 설정은 그대로 남습니다. 지우기 전에 사본이 저장됩니다.')),
        h('label.field', '보관 기간', keep),
        preview,
      ],
      footer: [
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary.danger', {
          onclick: async () => {
            if (!(await confirmDialog(`${cutoff()} 이전의 활동 기록을 삭제할까요?`, {
              title: '기록 정리', danger: true, okLabel: '삭제',
            }))) return;
            const res = await api.post('/api/storage/prune', { before_day: cutoff() });
            close();
            toast(res.deleted ? `${res.deleted.toLocaleString()}건을 정리했습니다` : '정리할 기록이 없습니다', 'ok');
            onDone?.();
          },
        }, '정리'),
      ],
    };
  });
}

/**
 * 추적기 자가 진단.
 * "기록이 안 쌓이는데 왜인지 모르겠다"가 가장 답답한 상황이라, 어디서 막혔는지
 * 사람이 읽을 수 있는 형태로 보여 준다.
 */
async function runDiagnosis(button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = '확인 중…';
  let result;
  try {
    result = await api.post('/api/tracker/diagnose');
  } finally {
    button.disabled = false;
    button.textContent = original;
  }

  openModal(() => ({
    title: result.ok ? '진단: 이상 없음' : '진단: 문제가 있습니다',
    body: [
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '7px', fontSize: '13px' } },
        result.checks.map((c) => h('div.row', { style: { alignItems: 'flex-start', gap: '9px' } },
          h('span', { style: { color: c.ok ? 'var(--good)' : 'var(--bad)', flex: 'none' } }, c.ok ? '✓' : '✗'),
          h('div', { style: { minWidth: 0 } },
            h('div', c.name),
            h('div.muted', { style: { fontSize: '12px', wordBreak: 'break-word' } }, c.detail),
          ),
        )),
      ),
      result.ok
        ? null
        : h('div.hint', { style: { background: 'color-mix(in srgb, var(--warn) 11%, transparent)' } },
            h('span.icon', '!'),
            h('span',
              'PowerShell 실행이 막혀 있다면 관리자 없이도 다음으로 풀 수 있습니다: ',
              h('code', 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'),
              '. 백신·보안 소프트웨어가 스크립트 실행을 차단하는 경우도 있습니다.')),
      result.stderr
        ? h('div',
            h('div.section-title', { style: { marginTop: '4px' } }, '프로브 오류 출력'),
            h('pre', {
              style: {
                fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                background: 'var(--panel-2)', padding: '9px', borderRadius: 'var(--radius-sm)', margin: 0,
              },
            }, result.stderr))
        : null,
    ],
  }));
}

/**
 * 분류 규칙 추가·수정.
 *
 * 우선순위를 손댈 수 있어야 겹치는 규칙을 정리할 수 있다 —
 * "브라우저(앱)는 미분류지만 제목에 GitHub 이 있으면 개발" 같은 것이 그런 경우다.
 */
function openRuleForm(rule, categories, onDone) {
  const editing = Boolean(rule);
  openModal((close) => {
    const field = h('select',
      h('option', { value: 'app', selected: !editing || rule.field === 'app' }, '앱 이름'),
      h('option', { value: 'title', selected: editing && rule.field === 'title' }, '창 제목'),
    );
    const pattern = h('input', {
      type: 'text', placeholder: '예: Visual Studio Code, YouTube', autofocus: true,
      // 서버가 받는 만큼만 칠 수 있게 한다. 막아 두지 않으면 붙여 넣고 저장을 누른 뒤에야
      // 빨간 오류를 보게 된다 — 막을 수 있는 실패는 미리 막는다.
      maxlength: LIMITS.RULE_PATTERN,
    });
    if (editing) pattern.value = rule.pattern;

    const isRegex = h('input', { type: 'checkbox' });
    isRegex.checked = Boolean(editing && rule.is_regex);

    const category = h('select',
      categories.map((c) => h('option', {
        value: c.id, selected: editing && c.id === rule.category_id,
      }, `${c.name} (${KIND_LABELS[c.kind] || c.kind})`)),
    );

    const priority = h('input', {
      type: 'number', min: 1, max: 1000,
      value: editing ? rule.priority : 50,
    });
    // 제목 규칙이 앱 규칙보다 먼저 검사되도록 기본값을 맞춰 준다.
    field.addEventListener('change', () => {
      if (editing) return;
      priority.value = field.value === 'title' ? 50 : 90;
    });

    const submit = async () => {
      const value = pattern.value.trim();
      if (!value) { pattern.focus(); return; }
      const payload = {
        field: field.value,
        pattern: value,
        is_regex: isRegex.checked,
        category_id: Number(category.value),
        priority: Number(priority.value),
      };
      if (editing) {
        const res = await api.patch(`/api/rules/${rule.id}`, payload);
        close();
        toast(res.updated
          ? `규칙을 고치고 기존 기록 ${res.updated.toLocaleString()}건을 다시 분류했습니다`
          : '규칙을 고쳤습니다 — 바뀐 기록은 없습니다', 'ok');
      } else {
        const res = await api.post('/api/rules', { ...payload, apply_existing: true });
        close();
        toast(`규칙을 추가했고 기존 기록 ${res.updated.toLocaleString()}건을 갱신했습니다`, 'ok');
      }
      onDone?.();
    };
    pattern.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    return {
      title: editing ? '분류 규칙' : '새 분류 규칙',
      body: [
        h('div.grid.cols-2',
          h('label.field', '무엇을 볼까요', field),
          h('label.field', '우선순위', priority,
            h('span', { style: { fontSize: '11px' } }, '숫자가 작을수록 먼저 검사합니다')),
        ),
        h('label.field', '포함할 문구', pattern),
        h('label.row', { style: { fontSize: '13px', cursor: 'pointer' } },
          isRegex, h('span', '정규식으로 해석')),
        h('label.field', '이 분류로', category),
        h('div.hint',
          h('span.icon', 'i'),
          h('span', '창 제목 규칙을 앱 규칙보다 앞에 두면, 같은 브라우저라도 "GitHub"는 개발로 "YouTube"는 방해요소로 갈라집니다.')),
      ],
      footer: [
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: submit }, editing ? '저장' : '추가'),
      ],
    };
  });
}

/** 카테고리 추가·수정. 분석은 이름이 아니라 '종류'로 굴러가므로 종류 선택이 핵심이다. */
function openCategoryForm(category, onDone) {
  const editing = Boolean(category);
  openModal((close) => {
    const name = h('input', {
      type: 'text', placeholder: '예: 고객 응대', autofocus: true, maxlength: LIMITS.CATEGORY_NAME,
    });
    if (editing) name.value = category.name;

    const kind = h('select',
      Object.entries(KIND_LABELS).map(([value, label]) => h('option', {
        value, selected: editing ? category.kind === value : value === 'shallow',
      }, `${label} (${value})`)),
    );

    const colors = ['#4f9d69', '#5b8def', '#8a6fd1', '#3fa9a0', '#e0a458', '#d9534f', '#9aa0a6', '#6b7280'];
    let picked = editing ? category.color : colors[0];
    const swatches = colors.map((c) => h('button.btn.sm', {
      style: { background: c, width: '28px', height: '24px', borderColor: c },
      onclick: () => { picked = c; sync(); },
      'aria-label': `색상 ${c}`,
    }, ''));
    const sync = () => swatches.forEach((b, i) => {
      b.style.outline = colors[i] === picked ? '2px solid var(--text)' : 'none';
      b.style.outlineOffset = '1px';
    });
    sync();

    const submit = async () => {
      const value = name.value.trim();
      if (!value) { name.focus(); return; }
      const payload = { name: value, kind: kind.value, color: picked };
      if (editing) await api.patch(`/api/categories/${category.id}`, payload);
      else await api.post('/api/categories', payload);
      close();
      toast(editing ? '카테고리를 수정했습니다' : '카테고리를 만들었습니다', 'ok');
      await loadBase();
      onDone?.();
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

    const remove = async () => {
      const warning = category.activity_count
        ? `이 카테고리로 분류된 기록 ${category.activity_count.toLocaleString()}건의 분류가 지워집니다(기록 자체는 남습니다). `
        : '';
      const rules = category.rule_count ? `연결된 규칙 ${category.rule_count}개도 함께 사라집니다. ` : '';
      if (!(await confirmDialog(`${warning}${rules}"${category.name}" 을(를) 삭제할까요?`, {
        title: '카테고리 삭제', danger: true, okLabel: '삭제',
      }))) return;
      const res = await api.del(`/api/categories/${category.id}`);
      close();
      toast(res.unclassified ? `${res.unclassified.toLocaleString()}건이 미분류로 돌아갔습니다` : '삭제했습니다', 'ok');
      await loadBase();
      onDone?.();
    };

    return {
      title: editing ? '카테고리' : '새 카테고리',
      body: [
        h('label.field', '이름', name),
        h('label.field', '종류', kind,
          h('span', { style: { fontSize: '11px' } },
            '몰입(deep)만 몰입 시간·블록으로 계산됩니다. 방해(distraction)는 점수를 깎고, 휴식(break)은 어느 쪽에도 들어가지 않습니다.')),
        h('label.field', '색상', h('div.row.wrap', swatches)),
        editing
          ? h('div.muted', { style: { fontSize: '12px' } },
              `규칙 ${category.rule_count}개 · 이 분류가 붙은 기록 ${category.activity_count.toLocaleString()}건`)
          : null,
      ],
      footer: [
        editing ? h('button.btn.danger', { onclick: remove }, '삭제') : null,
        h('div.spacer'),
        h('button.btn', { onclick: close }, '취소'),
        h('button.btn.primary', { onclick: submit }, editing ? '저장' : '만들기'),
      ],
    };
  });
}

