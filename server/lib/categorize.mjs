import { all, get, run, tx, setting, setSetting } from './db.mjs';

/**
 * 카테고리 kind — 분석에서 "몰입/얕은 일/방해" 를 구분하는 축.
 * deep        : 깊은 몰입이 필요한 생산 활동
 * shallow     : 필요하지만 얕은 관리성 업무
 * comms       : 비동기 커뮤니케이션
 * meeting     : 동기 회의
 * break       : 의도된 휴식
 * distraction : 업무와 무관한 소모
 * other       : 미분류
 */
export const KINDS = ['deep', 'shallow', 'comms', 'meeting', 'break', 'distraction', 'other'];

const DEFAULT_CATEGORIES = [
  { name: '개발', kind: 'deep', color: '#4f9d69', sort_order: 10 },
  { name: '문서·작성', kind: 'deep', color: '#5b8def', sort_order: 20 },
  { name: '설계·리서치', kind: 'deep', color: '#8a6fd1', sort_order: 30 },
  { name: '학습', kind: 'deep', color: '#3fa9a0', sort_order: 40 },
  { name: '회의', kind: 'meeting', color: '#e0a458', sort_order: 50 },
  { name: '커뮤니케이션', kind: 'comms', color: '#4bb3c4', sort_order: 60 },
  { name: '관리·잡무', kind: 'shallow', color: '#9aa0a6', sort_order: 70 },
  { name: '방해요소', kind: 'distraction', color: '#d9534f', sort_order: 80 },
  { name: '휴식', kind: 'break', color: '#b0b6bd', sort_order: 90 },
  { name: '미분류', kind: 'other', color: '#6b7280', sort_order: 100 },
];

/**
 * 기본 분류 규칙: `[카테고리명, 필드, 패턴, 우선순위, 도입판]`.
 *
 * 우선순위 숫자가 작을수록 먼저 검사한다. **제목 규칙이 앱 규칙보다 앞선다** —
 * 브라우저는 앱 이름만으로 판단할 수 없기 때문이다. Chrome 을 통째로 "개발"로 묶으면
 * 그 안에서 본 유튜브까지 몰입 시간이 된다.
 *
 * 마지막 칸은 이 규칙이 들어온 판(版)이다. 규칙을 나중에 더 넣어도 이미 쓰고 있던
 * 사람에게 닿게 하려면 판 번호가 필요하다 — `DEFAULTS_VERSION` 설명을 보라.
 *
 * 패턴을 고를 때의 기준: **틀리게 분류하느니 미분류로 남는 편이 낫다.**
 * 미분류는 화면에 드러나고 한 번 누르면 정리되지만, 잘못 분류된 시간은 조용히
 * 지표를 물들이고 아무도 눈치채지 못한다. 그래서 'Line'(Outline·Deadline 에도 걸린다),
 * 'Mail', 'Flow'(Workflow) 처럼 흔한 낱말에 걸리는 조각은 일부러 넣지 않았다.
 */
const DEFAULT_RULES = [
  // ── 판 1 ─────────────────────────────────────────────
  ['회의', 'title', 'Google Meet', 10, 1],
  ['회의', 'title', 'Zoom Meeting', 10, 1],
  ['회의', 'title', 'Microsoft Teams 회의', 10, 1],
  ['회의', 'title', '| Meet', 12, 1],
  ['방해요소', 'title', 'YouTube', 20, 1],
  ['방해요소', 'title', 'Netflix', 20, 1],
  ['방해요소', 'title', 'Instagram', 20, 1],
  ['방해요소', 'title', 'Twitch', 20, 1],
  ['방해요소', 'title', 'Reddit', 20, 1],
  ['방해요소', 'title', '쿠팡', 22, 1],
  ['방해요소', 'title', '나무위키', 22, 1],
  ['커뮤니케이션', 'title', 'Gmail', 30, 1],
  ['커뮤니케이션', 'title', '받은편지함', 30, 1],
  ['개발', 'title', 'Stack Overflow', 40, 1],
  ['개발', 'title', 'GitHub', 40, 1],
  ['개발', 'title', 'localhost:', 42, 1],
  ['설계·리서치', 'title', 'Figma', 44, 1],

  ['개발', 'app', 'Visual Studio Code', 100, 1],
  ['개발', 'app', 'Cursor', 100, 1],
  ['개발', 'app', 'devenv', 100, 1],
  ['개발', 'app', 'Windows Terminal', 100, 1],
  ['개발', 'app', 'powershell', 100, 1],
  ['개발', 'app', 'WindowsTerminal', 100, 1],
  ['개발', 'app', 'IntelliJ', 100, 1],
  ['개발', 'app', 'PyCharm', 100, 1],
  ['개발', 'app', 'Claude', 100, 1],
  ['문서·작성', 'app', 'Word', 110, 1],
  ['문서·작성', 'app', 'Excel', 110, 1],
  ['문서·작성', 'app', 'PowerPoint', 110, 1],
  ['문서·작성', 'app', '한글', 110, 1],
  ['문서·작성', 'app', 'Hancom', 110, 1],
  ['문서·작성', 'app', 'Acrobat', 110, 1],
  ['문서·작성', 'app', 'Notion', 110, 1],
  ['문서·작성', 'app', 'Obsidian', 110, 1],
  ['문서·작성', 'app', 'Notepad', 112, 1],
  ['회의', 'app', 'Zoom', 120, 1],
  ['커뮤니케이션', 'app', 'Slack', 130, 1],
  ['커뮤니케이션', 'app', 'Teams', 130, 1],
  ['커뮤니케이션', 'app', 'KakaoTalk', 130, 1],
  ['커뮤니케이션', 'app', '카카오톡', 130, 1],
  ['커뮤니케이션', 'app', 'Outlook', 130, 1],
  ['커뮤니케이션', 'app', 'Discord', 130, 1],
  ['관리·잡무', 'app', 'Explorer', 140, 1],
  ['관리·잡무', 'app', '탐색기', 140, 1],
  ['관리·잡무', 'app', 'Settings', 140, 1],
  ['관리·잡무', 'app', '설정', 140, 1],

  // ── 판 2 ─────────────────────────────────────────────
  // 실제로 하루를 켜 두고 기록을 들여다보고 채웠다. 활동의 86% 가 미분류였고,
  // 그 대부분은 브라우저 안에서 벌어진 일과 업무용 웹 시스템이었다.
  // 브라우저 시간을 제목으로 가르지 못하면 이 도구가 내놓는 숫자는 아무 뜻이 없다.

  ['회의', 'title', 'Webex', 12, 2],
  ['회의', 'title', 'Whereby', 12, 2],

  ['방해요소', 'title', 'TikTok', 20, 2],
  ['방해요소', 'title', '틱톡', 20, 2],
  ['방해요소', 'title', 'Facebook', 20, 2],
  ['방해요소', 'title', '치지직', 20, 2],
  ['방해요소', 'title', 'DCInside', 22, 2],
  ['방해요소', 'title', '디시인사이드', 22, 2],
  ['방해요소', 'title', '에펨코리아', 22, 2],
  ['방해요소', 'title', '네이버 쇼핑', 22, 2],
  ['방해요소', 'title', 'G마켓', 22, 2],
  ['방해요소', 'title', '11번가', 22, 2],
  ['방해요소', 'title', '알리익스프레스', 22, 2],

  ['커뮤니케이션', 'title', 'Outlook', 30, 2],
  ['커뮤니케이션', 'title', '네이버 메일', 30, 2],
  ['커뮤니케이션', 'title', 'Daum 메일', 30, 2],
  ['커뮤니케이션', 'title', '안읽은 메시지', 32, 2],

  ['개발', 'title', 'GitLab', 40, 2],
  ['개발', 'title', 'Bitbucket', 40, 2],
  ['개발', 'title', 'Jira', 41, 2],
  ['개발', 'title', 'MDN Web Docs', 41, 2],
  ['개발', 'title', '127.0.0.1:', 42, 2],

  ['설계·리서치', 'title', 'Google 검색', 45, 2],
  ['설계·리서치', 'title', '- Google Search', 45, 2],
  ['설계·리서치', 'title', 'Miro', 46, 2],
  ['설계·리서치', 'title', 'arXiv', 46, 2],

  // 브라우저에서 하는 문서 작업. 미분류 시간의 가장 큰 덩어리였다.
  ['문서·작성', 'title', 'Google Docs', 48, 2],
  ['문서·작성', 'title', 'Google Sheets', 48, 2],
  ['문서·작성', 'title', 'Google Slides', 48, 2],
  ['문서·작성', 'title', 'Google Drive', 48, 2],
  ['문서·작성', 'title', 'Google 문서', 48, 2],
  ['문서·작성', 'title', 'Google 스프레드시트', 48, 2],
  ['문서·작성', 'title', 'Google 프레젠테이션', 48, 2],
  ['문서·작성', 'title', 'Confluence', 49, 2],
  ['문서·작성', 'title', 'Overleaf', 49, 2],

  // 업무용 웹 시스템. 브라우저 창 제목으로만 드러난다.
  // '나이스' 는 흔한 낱말이라 'NEIS' 와 '나이스 시스템' 으로 좁혔다.
  ['관리·잡무', 'title', '에듀파인', 52, 2],
  ['관리·잡무', 'title', '나이스 시스템', 52, 2],
  ['관리·잡무', 'title', 'NEIS', 52, 2],
  ['관리·잡무', 'title', '온나라', 52, 2],
  ['관리·잡무', 'title', '업무포털', 52, 2],
  ['관리·잡무', 'title', '관리 콘솔', 54, 2],
  ['관리·잡무', 'title', '- Google Admin', 54, 2],

  ['개발', 'app', 'Antigravity', 100, 2],
  ['개발', 'app', 'WebStorm', 100, 2],
  ['개발', 'app', 'Rider', 100, 2],
  ['개발', 'app', 'GoLand', 100, 2],
  ['개발', 'app', 'Android Studio', 100, 2],
  ['개발', 'app', 'Sublime Text', 100, 2],
  ['개발', 'app', 'DBeaver', 102, 2],
  ['개발', 'app', 'Postman', 102, 2],
  ['개발', 'app', 'GitHub Desktop', 102, 2],
  ['개발', 'app', 'SourceTree', 102, 2],
  ['개발', 'app', 'Docker Desktop', 102, 2],

  ['문서·작성', 'app', 'Typora', 112, 2],
  ['문서·작성', 'app', '메모장', 112, 2],
  ['문서·작성', 'app', 'OneNote', 112, 2],

  ['회의', 'app', 'Webex', 120, 2],

  ['커뮤니케이션', 'app', 'CoolMessenger', 130, 2],
  ['커뮤니케이션', 'app', '쿨메신저', 130, 2],
  ['커뮤니케이션', 'app', 'Thunderbird', 130, 2],
  ['커뮤니케이션', 'app', '네이트온', 130, 2],
  ['커뮤니케이션', 'app', 'NateOn', 130, 2],

  ['관리·잡무', 'app', 'WXSClient', 140, 2],
  ['관리·잡무', 'app', '작업 관리자', 142, 2],
  ['관리·잡무', 'app', 'Task Manager', 142, 2],
  ['관리·잡무', 'app', '제어판', 142, 2],

  ['방해요소', 'app', 'Steam', 150, 2],
  ['방해요소', 'app', 'Epic Games', 150, 2],
  ['방해요소', 'app', 'Battle.net', 150, 2],
];

/** 지금 코드가 알고 있는 기본 규칙의 판. 규칙을 더할 때마다 판 번호를 올린다. */
export const DEFAULTS_VERSION = Math.max(...DEFAULT_RULES.map((r) => r[4]));

/** 어느 판까지 심었는지 적어 두는 자리. */
const VERSION_KEY = 'rule_defaults_version';

function categoryIdsByName() {
  return new Map(all('SELECT id, name FROM categories').map((r) => [r.name, r.id]));
}

function insertRule(byName, [cat, field, pattern, priority], now) {
  const id = byName.get(cat);
  if (!id) return false;
  run(
    'INSERT INTO rules(field, pattern, is_regex, category_id, priority, created_at) VALUES (?, ?, 0, ?, ?, ?)',
    field, pattern, id, priority, now,
  );
  return true;
}

/** 첫 실행 시 기본 카테고리와 규칙을 심는다. 이미 있으면 아무것도 하지 않는다. */
export function seedDefaults() {
  const count = get('SELECT COUNT(*) AS n FROM categories').n;
  if (count > 0) return false;

  tx(() => {
    for (const c of DEFAULT_CATEGORIES) {
      run(
        'INSERT INTO categories(name, kind, color, sort_order) VALUES (?, ?, ?, ?)',
        c.name, c.kind, c.color, c.sort_order,
      );
    }
    const byName = categoryIdsByName();
    const now = Date.now();
    for (const rule of DEFAULT_RULES) insertRule(byName, rule, now);
    setSetting(VERSION_KEY, DEFAULTS_VERSION);
  });
  invalidateRules();
  return true;
}

/**
 * 이미 쓰고 있는 설치본에 **새로 추가된** 기본 규칙만 들여보낸다.
 *
 * `seedDefaults()` 는 카테고리가 비어 있을 때만 돈다. 그래서 지금까지는 기본 규칙을
 * 아무리 손봐도 어제 설치한 사람에게는 영원히 닿지 않았다 — 개선이 새 사용자에게만
 * 가는 구조였다. 실제로 하루 기록의 86% 가 미분류로 남은 것을 보고서야 알았다.
 *
 * 세 가지를 지킨다.
 *
 * 1. **지운 규칙을 되살리지 않는다.** 판 번호를 적어 두고, 그보다 나중 판의 규칙만
 *    넣는다. 사용자가 "YouTube = 방해요소" 를 일부러 지웠다면 그건 그 사람의 결정이다.
 * 2. **똑같은 규칙을 두 번 넣지 않는다.** 같은 필드·패턴이 이미 있으면 건너뛴다 —
 *    손으로 먼저 만들어 둔 사람의 우선순위와 카테고리를 존중한다.
 * 3. **없는 카테고리를 만들지 않는다.** 카테고리 이름을 바꿔 쓰는 사람이 있으므로,
 *    이름이 안 맞으면 그 규칙은 조용히 건너뛴다.
 *
 * @returns {{added: number, from: number, to: number, recategorized: number}}
 */
export function upgradeDefaults() {
  // 카테고리가 아예 없으면 첫 실행이다 — seedDefaults() 가 할 일이지 여기가 아니다.
  if (get('SELECT COUNT(*) AS n FROM categories').n === 0) {
    return { added: 0, from: 0, to: 0, recategorized: 0 };
  }

  // 판 번호가 적혀 있지 않은 설치본은 판을 세기 전에 깔린 것이다. 그런 설치본은
  // 반드시 판 1 전체를 심고 시작했으므로 1 로 본다. 여기서 0 으로 보면, 판 1 규칙 중
  // 사용자가 일부러 지운 것들이 업그레이드 한 번에 되살아난다.
  const recorded = setting(VERSION_KEY);
  const from = recorded === null ? 1 : Number(recorded) || 0;
  if (from >= DEFAULTS_VERSION) {
    setSetting(VERSION_KEY, DEFAULTS_VERSION);
    return { added: 0, from, to: DEFAULTS_VERSION, recategorized: 0 };
  }

  const existing = new Set(
    // \u0000 구분자 대신 공백을 쓰면 패턴에 공백이 들어 있을 때 서로 다른 규칙이 같은 키가 될 수 있다.
    // 글자로 쓰지 못하는 문자를 써야 겹치지 않는다. 소스에는 반드시 이스케이프로 적는다 —
    // 맨 글자를 박아 두면 파일이 바이너리가 되어 grep 도 diff 도 내용을 보여 주지 않는다.
    all('SELECT field, pattern FROM rules').map((r) => `${r.field}\u0000${r.pattern.toLowerCase()}`),
  );

  let added = 0;
  tx(() => {
    const byName = categoryIdsByName();
    const now = Date.now();
    for (const rule of DEFAULT_RULES) {
      const [, field, pattern, , since] = rule;
      if (since <= from) continue;
      if (existing.has(`${field}\u0000${pattern.toLowerCase()}`)) continue;
      if (insertRule(byName, rule, now)) added++;
    }
    setSetting(VERSION_KEY, DEFAULTS_VERSION);
  });
  invalidateRules();

  // 새 규칙은 과거 기록에도 적용해야 뜻이 있다. 어제까지 미분류였던 시간이
  // 오늘부터만 분류되면, 같은 화면 안에서 '몰입 시간' 의 뜻이 날짜마다 달라진다.
  const recategorized = added ? recategorizeAll() : 0;
  return { added, from, to: DEFAULTS_VERSION, recategorized };
}

let rulesCache = null;

export function invalidateRules() {
  rulesCache = null;
}

function compiled() {
  if (rulesCache) return rulesCache;
  const rows = all(`
    SELECT r.id, r.field, r.pattern, r.is_regex, r.category_id, r.priority
    FROM rules r
    ORDER BY r.priority ASC, r.id ASC
  `);
  rulesCache = rows.map((r) => {
    let re = null;
    if (r.is_regex) {
      try { re = new RegExp(r.pattern, 'i'); } catch { re = null; }
    }
    return { ...r, re, lower: r.pattern.toLowerCase() };
  });
  return rulesCache;
}

/** 미분류 카테고리 id (없으면 null). */
export function fallbackCategoryId() {
  const row = get("SELECT id FROM categories WHERE kind = 'other' ORDER BY sort_order LIMIT 1");
  return row ? row.id : null;
}

/**
 * 활동 한 건을 카테고리에 매핑한다.
 * @param {{app?: string, proc?: string, title?: string}} sample
 * @returns {number|null} category_id
 */
export function categorize(sample) {
  const app = `${sample.app || ''} ${sample.proc || ''}`.toLowerCase();
  const title = (sample.title || '').toLowerCase();

  for (const rule of compiled()) {
    const hay = rule.field === 'title' ? title : app;
    if (!hay) continue;
    const hit = rule.re ? rule.re.test(hay) : hay.includes(rule.lower);
    if (hit) return rule.category_id;
  }
  return fallbackCategoryId();
}

/**
 * 규칙이 바뀐 뒤 기존 활동 기록을 다시 분류한다.
 *
 * 손으로 정해 둔 기록(`pinned`)은 건드리지 않는다 — 규칙 하나 만들 때마다 사용자가
 * 고쳐 둔 것이 사라지면, 고치는 일 자체가 무의미해진다.
 *
 * **실제로 분류가 달라진 건수만** 센다. 전부 다시 쓰고 전체 행 수를 돌려주면
 * 아무것도 안 바뀌었을 때도 "15만 건을 다시 분류했습니다" 라고 말하게 되는데,
 * 그건 보고가 아니라 소음이다. 쓰기를 건너뛰는 만큼 빨라지기도 한다.
 */
export function recategorizeAll({ since = null } = {}) {
  // `pinned = 1` 은 사람이 직접 정한 분류다. 규칙은 이것을 덮지 않는다 —
  // 규칙은 앱과 창 제목만 보지만, 사람은 그 시간에 실제로 무엇을 했는지 알고 있다.
  const rows = since
    ? all('SELECT id, app, title, category_id FROM activity WHERE idle = 0 AND pinned = 0 AND started_at >= ?', since)
    : all('SELECT id, app, title, category_id FROM activity WHERE idle = 0 AND pinned = 0');
  let changed = 0;
  tx(() => {
    const stmt = 'UPDATE activity SET category_id = ? WHERE id = ?';
    for (const r of rows) {
      const cat = categorize({ app: r.app, title: r.title });
      if (cat === r.category_id) continue;
      run(stmt, cat, r.id);
      changed++;
    }
  });
  return changed;
}
