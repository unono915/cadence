import { createRouter, sendText } from '../lib/http.mjs';
import { int } from '../lib/validate.mjs';
import * as tasks from './tasks.mjs';
import * as focus from './focus.mjs';
import * as activity from './activity.mjs';
import * as analytics from './analytics.mjs';
import * as misc from './misc.mjs';
import * as backup from './backup.mjs';
import { tracker, lastSegment, diagnose } from '../tracker/tracker.mjs';
import { recategorizeAll } from '../lib/categorize.mjs';
import { recentErrors, errorLogPath, clearErrors } from '../lib/errorlog.mjs';

export function buildRouter() {
  const r = createRouter();

  // --- 상태 ---
  r.get('/api/health', () => ({
    ok: true,
    now: Date.now(),
    ...misc.runtimeInfo(),
    tracker: tracker.status(),
  }));

  // --- 태스크 ---
  r.get('/api/tasks', ({ query }) => tasks.listTasks(query));
  r.post('/api/tasks', ({ body }) => tasks.createTask(body));
  r.get('/api/tasks/:id', ({ params }) => tasks.getTask(int(params.id, 'id')));
  r.patch('/api/tasks/:id', ({ params, body }) => tasks.updateTask(int(params.id, 'id'), body));
  r.delete('/api/tasks/:id', ({ params }) => tasks.deleteTask(int(params.id, 'id')));
  r.post('/api/tasks/reorder', ({ body }) => tasks.reorderTasks(body.ids));

  // --- 프로젝트 ---
  r.get('/api/projects', ({ query }) => tasks.listProjects({ includeArchived: query.all === '1' }));
  r.post('/api/projects', ({ body }) => tasks.createProject(body));
  r.patch('/api/projects/:id', ({ params, body }) => tasks.updateProject(int(params.id, 'id'), body));
  r.delete('/api/projects/:id', ({ params }) => tasks.deleteProject(int(params.id, 'id')));

  // --- 집중 세션 ---
  r.get('/api/sessions', ({ query }) => focus.listSessions(query));
  r.get('/api/sessions/running', () => focus.runningSession());
  r.get('/api/sessions/suggest', () => focus.suggestSession());
  r.post('/api/sessions/record', ({ body }) => focus.recordPastSession(body));
  r.post('/api/sessions', ({ body }) => focus.startSession(body));
  r.post('/api/sessions/:id/end', ({ params, body }) => focus.endSession(int(params.id, 'id'), body));
  r.post('/api/sessions/:id/interrupt', ({ params }) => focus.bumpInterruption(int(params.id, 'id')));
  r.patch('/api/sessions/:id', ({ params, body }) => focus.updateSession(int(params.id, 'id'), body));
  r.delete('/api/sessions/:id', ({ params }) => focus.deleteSession(int(params.id, 'id')));

  // --- 활동 ---
  r.get('/api/activity', ({ query }) => activity.listActivity(query));
  r.get('/api/activity/summary', ({ query }) => activity.activitySummary(query));
  r.get('/api/activity/app', ({ query }) => activity.appDetail(query));
  r.get('/api/activity/search', ({ query }) => activity.searchActivity(query));
  r.post('/api/activity/manual', ({ body }) => activity.addManualActivity(body));
  r.get('/api/activity/manual/preview', ({ query }) => activity.manualPreview(query));
  r.get('/api/activity/range', ({ query }) => activity.rangePreview(query));
  r.post('/api/activity/range', ({ body }) => activity.assignRange(body));
  r.get('/api/activity/gaps', ({ query }) => activity.listGaps(query));
  r.get('/api/activity/gap-labels', ({ query }) => activity.gapLabels(query));
  r.get('/api/activity/unclassified', ({ query }) => activity.unclassifiedApps(query));
  r.get('/api/activity/title-suggestions', ({ query }) => activity.titleSuggestions(query));
  r.post('/api/activity/:id/resolve', ({ params, body }) => activity.resolveGap(int(params.id, 'id'), body));
  r.patch('/api/activity/:id', ({ params, body }) => activity.updateActivity(int(params.id, 'id'), body));
  r.delete('/api/activity/:id', ({ params }) => activity.deleteActivity(int(params.id, 'id')));

  // --- 분류 규칙 ---
  r.get('/api/categories', () => activity.listCategories());
  r.post('/api/categories', ({ body }) => activity.createCategory(body));
  r.patch('/api/categories/:id', ({ params, body }) => activity.updateCategory(int(params.id, 'id'), body));
  r.delete('/api/categories/:id', ({ params }) => activity.deleteCategory(int(params.id, 'id')));
  r.get('/api/rules', () => activity.listRules());
  r.post('/api/rules', ({ body }) => activity.teachRule(body));
  r.patch('/api/rules/:id', ({ params, body }) => activity.updateRule(int(params.id, 'id'), body));
  r.delete('/api/rules/:id', ({ params }) => activity.deleteRule(int(params.id, 'id')));
  r.post('/api/rules/recategorize', () => ({ updated: recategorizeAll() }));

  // --- 분석 ---
  r.get('/api/report/day', ({ query }) => analytics.dayReport(query));
  r.get('/api/report/week', ({ query }) => analytics.weekReport(query));
  r.get('/api/report/trend', ({ query }) => analytics.trend(query));
  r.get('/api/report/rhythm', ({ query }) => analytics.rhythm(query));
  r.get('/api/report/range', ({ query }) => analytics.rangeReport(query));

  // --- 노트 ---
  r.get('/api/notes', ({ query }) => misc.getNote(query));
  r.put('/api/notes', ({ body }) => misc.putNote(body));
  r.post('/api/notes/append', ({ body }) => misc.appendNote(body));

  // --- 설정 ---
  r.get('/api/settings', () => misc.getSettings());
  r.patch('/api/settings', ({ body }) => misc.patchSettings(body));

  // --- 추적기 제어 ---
  r.get('/api/tracker', () => ({ ...tracker.status(), last: lastSegment() }));
  r.post('/api/tracker/start', () => { tracker.resume(); return tracker.status(); });
  r.post('/api/tracker/pause', () => { tracker.pause(); return tracker.status(); });
  r.post('/api/tracker/diagnose', () => diagnose());

  // --- 오류 기록 ---
  // 콘솔 없이 자동 실행하는 경우를 위해, 최근 오류를 화면에서 볼 수 있게 한다.
  r.get('/api/errors', () => ({ path: errorLogPath(), errors: recentErrors() }));
  r.delete('/api/errors', () => clearErrors());

  // --- 내보내기 ---
  r.get('/api/export/day.md', ({ query, res }) => {
    sendText(res, 200, misc.dayMarkdown(query), 'text/markdown; charset=utf-8');
  });
  r.get('/api/export/week.md', ({ query, res }) => {
    sendText(res, 200, misc.weekMarkdown(query), 'text/markdown; charset=utf-8');
  });
  r.get('/api/export/range.md', ({ query, res }) => {
    sendText(res, 200, misc.rangeMarkdown(query), 'text/markdown; charset=utf-8');
  });
  r.get('/api/export/tasks.csv', ({ query, res }) => {
    sendText(res, 200, `﻿${misc.rangeTasksCsv(query)}`, 'text/csv; charset=utf-8');
  });
  r.get('/api/export/activity.csv', ({ query, res }) => {
    // BOM 을 붙여 Excel 에서 한글이 깨지지 않게 한다.
    sendText(res, 200, `﻿${misc.activityCsv(query)}`, 'text/csv; charset=utf-8');
  });
  r.get('/api/export/all.json', () => misc.exportAll());

  // --- 백업 복원 / 저장 공간 ---
  r.get('/api/storage', () => backup.storageStats());
  r.post('/api/import', ({ body }) => backup.importBackup(body.data, body.mode || 'replace'));
  r.post('/api/storage/snapshot', () => ({ snapshot: backup.snapshotDatabase() }));
  r.post('/api/storage/prune', ({ body }) => backup.pruneActivity(body.before_day));
  r.post('/api/storage/forget-titles', () => backup.forgetTitles());
  r.get('/api/storage/integrity', () => backup.integrityCheck());
  r.post('/api/storage/repair', () => backup.repairIntegrity());

  return r;
}
