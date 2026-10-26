import type { FirstSyncMergePayload } from './first-sync-merge';

/**
 * Counts keys the way the server's `validatePayloadComplexity` does
 * (packages/super-sync-server/src/sync/services/validation.service.ts):
 * every object key and every array element, recursively.
 */
export const countPayloadKeys = (v: unknown): number => {
  if (v === null || typeof v !== 'object') return 0;
  const children: unknown[] = Array.isArray(v) ? v : Object.values(v);
  return children.length + children.reduce<number>((n, c) => n + countPayloadKeys(c), 0);
};

const ARRAY_FIELDS = [
  'projects',
  'tasks',
  'tags',
  'notes',
  'taskRepeatCfgs',
  'issueProviders',
  'archiveTasks',
] as const;

const emptyChunk = (): FirstSyncMergePayload => ({
  projects: [],
  tasks: [],
  tags: [],
  notes: [],
  taskRepeatCfgs: [],
  issueProviders: [],
  timeTracking: { project: {}, tag: {} },
  globalConfig: null,
  archiveTasks: [],
});

/**
 * Splits a merge payload so each `applyFirstSyncMerge` op stays below the server's
 * 20,000-key limit for non-full-state ops (default 10,000 leaves room for the op wrapper).
 * Entities and (context, date) time tracking entries are atomic; one bigger than
 * maxKeys gets its own chunk. globalConfig goes into the first chunk only.
 * Always returns at least one chunk (an empty payload gives one empty chunk).
 * Chunks are upsert-only and disjoint, so their apply order does not change the result.
 */
export const splitFirstSyncMergePayload = (
  payload: FirstSyncMergePayload,
  maxKeys = 10_000,
): FirstSyncMergePayload[] => {
  const base = countPayloadKeys(emptyChunk());
  const chunks: FirstSyncMergePayload[] = [];
  let cur = emptyChunk();
  let used = base;
  // cost is an upper bound of the keys an item adds, so a chunk never exceeds maxKeys
  const add = (cost: number, put: (c: FirstSyncMergePayload) => void): void => {
    if (used > base && used + cost > maxKeys) {
      chunks.push(cur);
      cur = emptyChunk();
      used = base;
    }
    put(cur);
    used += cost;
  };

  if (payload.globalConfig) {
    const cfg = payload.globalConfig;
    add(countPayloadKeys(cfg), (c) => (c.globalConfig = cfg));
  }
  for (const field of ARRAY_FIELDS) {
    for (const item of payload[field]) {
      add(1 + countPayloadKeys(item), (c) => (c[field] as unknown[]).push(item));
    }
  }
  for (const kind of ['project', 'tag'] as const) {
    for (const [ctx, byDate] of Object.entries(payload.timeTracking[kind])) {
      for (const [date, entry] of Object.entries(byDate)) {
        // +1 date key, +1 context key (if new in this chunk)
        add(2 + countPayloadKeys(entry), (c) => {
          c.timeTracking[kind][ctx] = { ...c.timeTracking[kind][ctx], [date]: entry };
        });
      }
    }
  }
  chunks.push(cur);
  return chunks;
};
