import { Action } from '@ngrx/store';
import { countPayloadKeys, splitFirstSyncMergePayload } from './first-sync-merge-chunks';
import { FirstSyncMergePayload } from './first-sync-merge';
import { DEFAULT_TASK, Task, TaskCopy } from '../../../features/tasks/task.model';
import { DEFAULT_GLOBAL_CONFIG } from '../../../features/config/default-global-config.const';
import { firstSyncMergeMetaReducer } from '../../../root-store/meta/first-sync-merge.meta-reducer';
import { applyFirstSyncMerge } from '../../../root-store/meta/first-sync-merge.actions';
import { createBaseState } from '../../../root-store/meta/task-shared-meta-reducers/test-utils';
import { TIME_TRACKING_FEATURE_KEY } from '../../../features/time-tracking/store/time-tracking.reducer';
import { CONFIG_FEATURE_NAME } from '../../../features/config/store/global-config.reducer';

// Port of validatePayloadComplexity (key counting) in
// packages/super-sync-server/src/sync/services/validation.service.ts.
// The server package cannot be imported from client tests.
const SERVER_MAX_KEYS = 20000;
const serverAccepts = (payload: unknown): boolean => {
  let totalKeys = 0;
  const check = (obj: unknown): boolean => {
    if (obj === null || typeof obj !== 'object') return true;
    if (Array.isArray(obj)) {
      totalKeys += obj.length;
      if (totalKeys > SERVER_MAX_KEYS) return false;
      return obj.every(check);
    }
    const keys = Object.keys(obj);
    totalKeys += keys.length;
    if (totalKeys > SERVER_MAX_KEYS) return false;
    return keys.every((k) => check((obj as Record<string, unknown>)[k]));
  };
  return check(payload);
};
// what OperationLogEffects actually uploads as op.payload
const asOpPayload = (chunk: FirstSyncMergePayload): unknown => ({
  actionPayload: { payload: chunk },
  entityChanges: [],
});

const empty = (): FirstSyncMergePayload => ({
  projects: [],
  tasks: [],
  tags: [],
  notes: [],
  taskRepeatCfgs: [],
  issueProviders: [],
  timeTracking: { project: {}, tag: {} },
  globalConfig: null,
  archiveTasks: [],
  simpleCounters: [],
  metrics: [],
  reminders: [],
  boardCfgs: [],
  plannerDays: {},
  pluginUserData: [],
  pluginMetadata: [],
  menuTree: null,
});

const mkTask = (id: string): Task => ({ ...DEFAULT_TASK, id, title: id, projectId: 'p' });

const bigPayload = (): FirstSyncMergePayload => {
  const project: Record<string, Record<string, { s: number; e: number }>> = {};
  for (let i = 0; i < 400; i++) project[`p${i % 4}`] = { ...project[`p${i % 4}`] };
  for (let i = 0; i < 400; i++) {
    project[`p${i % 4}`][`2025-01-${String(i).padStart(3, '0')}`] = { s: i, e: i + 1 };
  }
  return {
    ...empty(),
    tasks: Array.from({ length: 3000 }, (_, i) => mkTask(`t${i}`)),
    archiveTasks: Array.from(
      { length: 500 },
      (_, i) => mkTask(`a${i}`) as unknown as TaskCopy,
    ),
    timeTracking: { project, tag: {} },
    globalConfig: DEFAULT_GLOBAL_CONFIG,
    reminders: Array.from({ length: 300 }, (_, i) => ({
      id: `r${i}`,
      relatedId: `t${i}`,
      type: 'TASK' as const,
      remindAt: i,
      title: `r${i}`,
    })),
    metrics: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, notes: 'x' })),
    plannerDays: Object.fromEntries(
      Array.from({ length: 300 }, (_, i) => [`d${i}`, [`t${i}`, `t${i + 1}`]]),
    ),
    pluginUserData: [{ id: 'u', data: 'x' }],
    pluginMetadata: [{ id: 'm', isEnabled: true }],
    menuTree: { projectTree: [], tagTree: [] },
  };
};

const union = (chunks: FirstSyncMergePayload[]): FirstSyncMergePayload => {
  const u = empty();
  for (const c of chunks) {
    u.projects.push(...c.projects);
    u.tasks.push(...c.tasks);
    u.tags.push(...c.tags);
    u.notes.push(...c.notes);
    u.taskRepeatCfgs.push(...c.taskRepeatCfgs);
    u.issueProviders.push(...c.issueProviders);
    u.archiveTasks.push(...c.archiveTasks);
    u.simpleCounters.push(...c.simpleCounters);
    u.metrics.push(...c.metrics);
    u.reminders.push(...c.reminders);
    u.boardCfgs.push(...c.boardCfgs);
    u.pluginUserData.push(...c.pluginUserData);
    u.pluginMetadata.push(...c.pluginMetadata);
    for (const [day, ids] of Object.entries(c.plannerDays)) {
      expect(u.plannerDays[day]).toBeUndefined(); // no duplicates
      u.plannerDays[day] = ids;
    }
    if (c.menuTree) {
      expect(u.menuTree).toBeNull();
      u.menuTree = c.menuTree;
    }
    for (const kind of ['project', 'tag'] as const) {
      for (const [ctx, byDate] of Object.entries(c.timeTracking[kind])) {
        for (const [date, entry] of Object.entries(byDate)) {
          expect(u.timeTracking[kind][ctx]?.[date]).toBeUndefined(); // no duplicates
          u.timeTracking[kind][ctx] = { ...u.timeTracking[kind][ctx], [date]: entry };
        }
      }
    }
    if (c.globalConfig) {
      expect(u.globalConfig).toBeNull(); // only once
      u.globalConfig = c.globalConfig;
    }
  }
  return u;
};

describe('splitFirstSyncMergePayload', () => {
  it('countPayloadKeys matches the server counting rule', () => {
    expect(countPayloadKeys({ a: [1, { b: 2 }], c: null })).toBe(5);
  });

  it('returns one empty chunk for an empty payload', () => {
    expect(splitFirstSyncMergePayload(empty())).toEqual([empty()]);
  });

  it('keeps a small payload in one chunk', () => {
    const p = { ...empty(), tasks: [mkTask('a'), mkTask('b')] };
    expect(splitFirstSyncMergePayload(p)).toEqual([p]);
  });

  it('splits a big payload into server-accepted chunks without loss', () => {
    const p = bigPayload();
    expect(serverAccepts(asOpPayload(p))).toBe(false);
    const chunks = splitFirstSyncMergePayload(p);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c) => {
      expect(countPayloadKeys(c)).toBeLessThanOrEqual(10_000);
      expect(serverAccepts(asOpPayload(c))).toBe(true);
    });
    expect(chunks[0].globalConfig).toEqual(DEFAULT_GLOBAL_CONFIG);
    expect(chunks.slice(1).every((c) => c.globalConfig === null)).toBe(true);
    expect(union(chunks)).toEqual(p);
  });

  it('puts an entity larger than maxKeys into its own chunk', () => {
    const p = { ...empty(), tasks: [mkTask('a'), mkTask('b'), mkTask('c')] };
    const chunks = splitFirstSyncMergePayload(p, 5);
    expect(chunks.map((c) => c.tasks.map((t) => t.id))).toEqual([['a'], ['b'], ['c']]);
  });

  it('gives the same state when chunks are applied in reverse order', () => {
    const reducer = firstSyncMergeMetaReducer((s: unknown, _a: Action) => s);
    const base = {
      ...createBaseState(),
      [TIME_TRACKING_FEATURE_KEY]: { project: {}, tag: {} },
      [CONFIG_FEATURE_NAME]: DEFAULT_GLOBAL_CONFIG,
    };
    const run = (chunks: FirstSyncMergePayload[]): unknown =>
      chunks.reduce(
        (s, payload) => reducer(s, applyFirstSyncMerge({ payload })),
        base as unknown,
      );
    // entity content is order independent; adapter `ids` keep insertion order
    const norm = (st: unknown): unknown =>
      JSON.parse(
        JSON.stringify(st, (_k, v: unknown) =>
          v && typeof v === 'object' && 'ids' in v && 'entities' in v
            ? { ...v, ids: [...(v as { ids: string[] }).ids].sort() }
            : v,
        ),
      );
    const chunks = splitFirstSyncMergePayload(bigPayload());
    expect(norm(run([...chunks].reverse()))).toEqual(norm(run(chunks)));
  });
});
