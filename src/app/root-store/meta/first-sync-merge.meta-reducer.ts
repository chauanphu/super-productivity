import { Action, ActionReducer, MetaReducer } from '@ngrx/store';
import { EntityAdapter, EntityState } from '@ngrx/entity';
import { applyFirstSyncMerge } from './first-sync-merge.actions';
import {
  PROJECT_FEATURE_NAME,
  projectAdapter,
} from '../../features/project/store/project.reducer';
import { TASK_FEATURE_NAME, taskAdapter } from '../../features/tasks/store/task.reducer';
import { TAG_FEATURE_NAME, tagAdapter } from '../../features/tag/store/tag.reducer';
import {
  adapter as noteAdapter,
  NOTE_FEATURE_NAME,
} from '../../features/note/store/note.reducer';
import {
  adapter as taskRepeatCfgAdapter,
  TASK_REPEAT_CFG_FEATURE_NAME,
} from '../../features/task-repeat-cfg/store/task-repeat-cfg.selectors';
import {
  adapter as issueProviderAdapter,
  ISSUE_PROVIDER_FEATURE_KEY,
} from '../../features/issue/store/issue-provider.reducer';
import { CONFIG_FEATURE_NAME } from '../../features/config/store/global-config.reducer';
import { TIME_TRACKING_FEATURE_KEY } from '../../features/time-tracking/store/time-tracking.reducer';
import { TimeTrackingState } from '../../features/time-tracking/time-tracking.model';
import { GlobalConfigState } from '../../features/config/global-config.model';
import { TODAY_TAG } from '../../features/tag/tag.const';

type AnyState = Record<string, unknown>;

/** Replaces (setMany) entities by ID; never deletes. */
const setMany = <T extends { id: string }>(
  state: AnyState,
  key: string,
  adapter: EntityAdapter<T>,
  items: T[],
): AnyState =>
  items.length && state[key]
    ? { ...state, [key]: adapter.setMany(items, state[key] as EntityState<T>) }
    : state;

const mergeTimeTracking = (
  cur: TimeTrackingState,
  add: TimeTrackingState,
): TimeTrackingState => {
  const out: TimeTrackingState = { project: { ...cur.project }, tag: { ...cur.tag } };
  for (const kind of ['project', 'tag'] as const) {
    for (const [ctx, byDate] of Object.entries(add[kind] ?? {})) {
      out[kind][ctx] = { ...out[kind][ctx], ...byDate };
    }
  }
  return out;
};

/**
 * Applies applyFirstSyncMerge in a single reducer pass (one op in the sync log).
 * Upsert-only and idempotent, so remote replay is safe. TODAY is virtual: it is
 * never written into tagIds and the TODAY tag entity is never replaced.
 */
export const firstSyncMergeMetaReducer: MetaReducer = (
  reducer: ActionReducer<unknown, Action>,
) => {
  return (state: unknown, action: Action) => {
    if (!state || action.type !== applyFirstSyncMerge.type) {
      return reducer(state, action);
    }
    const { payload } = action as ReturnType<typeof applyFirstSyncMerge>;
    let s = state as AnyState;

    s = setMany(s, PROJECT_FEATURE_NAME, projectAdapter, payload.projects);
    s = setMany(
      s,
      TASK_FEATURE_NAME,
      taskAdapter,
      payload.tasks.map((t) =>
        t.tagIds.includes(TODAY_TAG.id)
          ? { ...t, tagIds: t.tagIds.filter((id) => id !== TODAY_TAG.id) }
          : t,
      ),
    );
    s = setMany(
      s,
      TAG_FEATURE_NAME,
      tagAdapter,
      payload.tags.filter((t) => t.id !== TODAY_TAG.id),
    );
    s = setMany(s, NOTE_FEATURE_NAME, noteAdapter, payload.notes);
    s = setMany(
      s,
      TASK_REPEAT_CFG_FEATURE_NAME,
      taskRepeatCfgAdapter,
      payload.taskRepeatCfgs,
    );
    s = setMany(
      s,
      ISSUE_PROVIDER_FEATURE_KEY,
      issueProviderAdapter,
      payload.issueProviders,
    );

    // Archive-located time tracking is not split out: active entries are moved to
    // archiveYoung by the regular archive flush (sortTimeTrackingDataToArchiveYoung).
    const tt = s[TIME_TRACKING_FEATURE_KEY] as TimeTrackingState | undefined;
    if (tt) {
      s = {
        ...s,
        [TIME_TRACKING_FEATURE_KEY]: mergeTimeTracking(tt, payload.timeTracking),
      };
    }

    const cfg = s[CONFIG_FEATURE_NAME] as GlobalConfigState | undefined;
    if (payload.globalConfig && cfg) {
      // per section, so sections/fields missing in an older payload keep current values;
      // the sync section is per device (provider, enabled, encryption)
      const merged: Record<string, unknown> = { ...cfg };
      for (const [k, v] of Object.entries(payload.globalConfig)) {
        const c = (cfg as unknown as Record<string, unknown>)[k];
        merged[k] =
          v && c && typeof v === 'object' && typeof c === 'object' && !Array.isArray(v)
            ? { ...c, ...v }
            : v;
      }
      s = { ...s, [CONFIG_FEATURE_NAME]: { ...merged, sync: cfg.sync } };
    }

    return reducer(s, action);
  };
};
