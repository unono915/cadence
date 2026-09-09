import { h, clear } from '../lib/dom.js';
import { api } from '../lib/api.js';
import { toast } from '../lib/ui.js';
import { store, refreshTracker, notify, setDay } from '../lib/store.js';
import { dur, shiftDay } from '../lib/format.js';
import { openQuickAdd } from './quick-add.js';
import { openPlanPicker } from './daily-plan.js';
import { openActivitySearch } from './activity-search.js';

/**
 * 명령 팔레트 (Ctrl/Cmd+K).
 *
 * 화면을 옮겨 다니지 않고 한 곳에서 이동·실행·검색을 한다.
 * 태스크는 제목뿐 아니라 초성으로도 찾을 수 있다 — 한글 입력을 다 치지 않아도 되도록.
 */

const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ',
  'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

/** '설계 문서' → 'ㅅㄱ ㅁㅅ' */
export function initials(text) {
  let out = '';
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (code >= 0xac00 && code <= 0xd7a3) out += CHO[Math.floor((code - 0xac00) / 588)];
    else out += ch;
  }
  return out.toLowerCase();
}

/** 부분 문자열 + 초성 매칭. 점수가 낮을수록 먼저 나온다. */
function score(query, text) {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx === 0) return 0;
  if (idx > 0) return 1 + idx / 100;
  // 초성 검색에서는 공백을 무시한다 — "성능 프로파일링"을 'ㅅㄴㅍ' 로 찾을 수 있도록.
  const ini = initials(text).replace(/\s+/g, '');
  const iIdx = ini.indexOf(initials(query).replace(/\s+/g, ''));
  if (iIdx === 0) return 2;
  if (iIdx > 0) return 3 + iIdx / 100;
  return Infinity;
}

let closePalette = null;

export function openPalette({ onNavigate } = {}) {
  if (closePalette) { closePalette(); return; }

  const overlay = h('div.palette-overlay');
  const input = h('input', {
    type: 'text',
    placeholder: '이동 · 실행 · 태스크 검색…',
    autocomplete: 'off',
    spellcheck: false,
  });
  const listEl = h('div.palette-list');
  const hint = h('div.palette-hint',
    h('span', '↑↓ 이동'), h('span', '↵ 실행'), h('span', 'Esc 닫기'),
  );

  const panel = h('div.palette', { onclick: (e) => e.stopPropagation() },
    h('div.palette-input', input),
    listEl,
    hint,
  );
  overlay.append(panel);
  document.body.append(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    closePalette = null;
  };
  closePalette = close;
  overlay.onclick = close;

  let items = [];
  let cursor = 0;
  let tasks = [];

  api.get('/api/tasks', { status: 'todo,doing' }).then((rows) => {
    tasks = rows;
    paint();
  }).catch(() => {});

  function commands() {
    const s = store.session;
    const t = store.tracker || {};
    const out = [
      { group: '이동', label: '오늘', hint: '1', run: () => go('today') },
      { group: '이동', label: '태스크', hint: '2', run: () => go('tasks') },
      { group: '이동', label: '타임라인', hint: '3', run: () => go('timeline') },
      { group: '이동', label: '리포트', hint: '4', run: () => go('reports') },
      { group: '이동', label: '설정', hint: '5', run: () => go('settings') },
      { group: '실행', label: '새 태스크', hint: 'N', run: () => openQuickAdd('task') },
      { group: '실행', label: '빠른 메모', run: () => openQuickAdd('note') },
      { group: '실행', label: '오늘 할 일 고르기', run: () => openPlanPicker(store.day, () => notify('tasks')) },
      { group: '실행', label: '활동 기록 전체 검색', run: () => openActivitySearch() },
      { group: '날짜', label: '오늘로', run: () => setDay(store.today) },
      { group: '날짜', label: '어제로', run: () => setDay(shiftDay(store.today, -1)) },
      { group: '날짜', label: '하루 전으로', hint: '←', run: () => setDay(shiftDay(store.day, -1)) },
      { group: '날짜', label: '하루 뒤로', hint: '→', run: () => setDay(shiftDay(store.day, 1)) },
    ];

    if (s) {
      out.push({
        group: '실행',
        label: `세션 종료 (${s.task_title || (s.kind === 'break' ? '휴식' : '집중')})`,
        hint: 'F',
        run: async () => { const m = await import('../app.js'); await m.endCurrentSession(); },
      });
      out.push({
        group: '실행', label: '방해 1회 기록', hint: 'I',
        run: async () => { await api.post(`/api/sessions/${s.id}/interrupt`); toast('방해 1회 기록'); },
      });
    } else {
      out.push({
        group: '실행', label: '집중 세션 시작', hint: 'F',
        run: async () => { const m = await import('../app.js'); await m.startFocus(); },
      });
      out.push({
        group: '실행', label: '휴식 시작',
        run: async () => { const m = await import('../app.js'); await m.startBreak(); },
      });
    }

    out.push({
      group: '실행',
      label: t.running ? '자동 추적 일시정지' : '자동 추적 시작',
      run: async () => {
        await api.post(t.running ? '/api/tracker/pause' : '/api/tracker/start');
        await refreshTracker();
        toast(t.running ? '자동 추적을 멈췄습니다' : '자동 추적을 시작했습니다', 'ok');
      },
    });
    out.push({
      group: '실행', label: '오늘 요약 복사 (마크다운)',
      run: async () => {
        const md = await api.getText('/api/export/day.md', { day: store.day });
        try { await navigator.clipboard.writeText(md); toast('클립보드에 복사했습니다', 'ok'); }
        catch { toast('복사에 실패했습니다 — 리포트 화면에서 열어 보세요', 'err'); }
      },
    });
    return out;
  }

  function go(view) {
    location.hash = `#/${view}`;
    onNavigate?.(view);
  }

  function taskCommands() {
    return tasks.map((t) => ({
      group: '태스크',
      label: t.title,
      meta: [t.project_name, t.estimate_min ? `${t.estimate_min}분` : null, t.actual_sec ? dur(t.actual_sec) : null]
        .filter(Boolean).join(' · '),
      hint: '집중 시작',
      run: async () => {
        const m = await import('../app.js');
        await m.startFocus(t.id);
      },
    }));
  }

  function paint() {
    const q = input.value.trim();
    const pool = [...commands(), ...taskCommands()];
    items = q
      ? pool
          .map((c) => ({ c, s: score(q, `${c.label} ${c.meta || ''}`) }))
          .filter((x) => x.s !== Infinity)
          .sort((a, b) => a.s - b.s)
          .slice(0, 12)
          .map((x) => x.c)
      : pool.filter((c) => c.group !== '태스크').concat(taskCommands().slice(0, 4));

    cursor = Math.min(cursor, Math.max(0, items.length - 1));
    clear(listEl);

    if (!items.length) {
      listEl.append(h('div.empty', '일치하는 항목이 없습니다'));
      return;
    }

    let lastGroup = null;
    items.forEach((item, i) => {
      if (item.group !== lastGroup) {
        listEl.append(h('div.palette-group', item.group));
        lastGroup = item.group;
      }
      listEl.append(h('div.palette-item', {
        class: i === cursor ? 'on' : '',
        onclick: () => execute(i),
        onmousemove: () => { if (cursor !== i) { cursor = i; paint(); } },
      },
        h('span.nowrap', { style: { flex: 1 } }, item.label),
        item.meta ? h('span.palette-meta.nowrap', item.meta) : null,
        item.hint ? h('span.palette-key', item.hint) : null,
      ));
    });

    listEl.querySelector('.palette-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  async function execute(i) {
    const item = items[i];
    if (!item) return;
    close();
    try {
      await item.run();
    } catch (err) {
      console.error(err);
    }
  }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); cursor = (cursor + 1) % items.length; paint(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); cursor = (cursor - 1 + items.length) % items.length; paint(); return; }
    if (e.key === 'Enter') { e.preventDefault(); execute(cursor); }
  }

  input.addEventListener('input', () => { cursor = 0; paint(); });
  document.addEventListener('keydown', onKey, true);
  paint();
  setTimeout(() => input.focus(), 20);
  return close;
}
