import { createAction } from '@ngrx/store';
import type { FirstSyncMergePayload } from '../../op-log/sync/first-sync-merge/first-sync-merge';
import { PersistentActionMeta } from '../../op-log/core/persistent-action.interface';
import { OpType } from '../../op-log/core/operation.types';

/**
 * Writes a first-sync merge payload on top of the downloaded remote state as ONE op.
 * Store part: firstSyncMergeMetaReducer. Archive part: ArchiveOperationHandler.
 */
export const applyFirstSyncMerge = createAction(
  '[Sync] Apply first-sync merge',
  (actionProps: { payload: FirstSyncMergePayload }) => ({
    ...actionProps,
    meta: {
      isPersistent: true,
      entityType: 'ALL', // spans projects, tasks, tags, notes, config, time tracking, archive
      opType: OpType.Batch,
    } satisfies PersistentActionMeta,
  }),
);
