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
import {
  adapter as simpleCounterAdapter,
  SIMPLE_COUNTER_FEATURE_NAME,
} from '../../features/simple-counter/store/simple-counter.reducer';
import {
  METRIC_FEATURE_NAME,
  metricAdapter,
} from '../../features/metric/store/metric.reducer';
import { REMINDER_FEATURE_NAME } from '../../features/reminder/store/reminder.reducer';
import {
  BOARDS_FEATURE_NAME,
  BoardsState,
} from '../../features/boards/store/boards.reducer';
import {
  plannerFeatureKey,
  PlannerState,
} from '../../features/planner/store/planner.reducer';
import { PLUGIN_USER_DATA_FEATURE_NAME } from '../../plugins/store/plugin-user-data.reducer';
import { PLUGIN_METADATA_FEATURE_NAME } from '../../plugins/store/plugin-metadata.reducer';
import { menuTreeFeatureKey } from '../../features/menu-tree/store/menu-tree.reducer';

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

/** Upserts by ID into a plain array (replace in place, else append); never deletes. */
const upsertById = <T extends { id: string }>(
  cur: readonly T[],
  items: readonly T[] | undefined,
): T[] => {
  if (!items?.length) return cur as T[];
  const incoming = new Map(items.map((i) => [i.id, i]));
  const out = cur.map((c) => incoming.get(c.id) ?? c);
  const known = new Set(cur.map((c) => c.id));
  return [...out, ...items.filter((i) => !known.has(i.id))];
};

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

    // fields below were added later: tolerate payloads without them
    s = setMany(
      s,
      SIMPLE_COUNTER_FEATURE_NAME,
      simpleCounterAdapter,
      payload.simpleCounters ?? [],
    );
    s = setMany(s, METRIC_FEATURE_NAME, metricAdapter, payload.metrics ?? []);
    const arraySlices = [
      [REMINDER_FEATURE_NAME, payload.reminders],
      [PLUGIN_USER_DATA_FEATURE_NAME, payload.pluginUserData],
      [PLUGIN_METADATA_FEATURE_NAME, payload.pluginMetadata],
    ] as const;
    for (const [key, items] of arraySlices) {
      const cur = s[key] as { id: string }[] | undefined;
      if (cur && items?.length) {
        s = { ...s, [key]: upsertById(cur, items) };
      }
    }
    const boards = s[BOARDS_FEATURE_NAME] as BoardsState | undefined;
    if (boards && payload.boardCfgs?.length) {
      s = {
        ...s,
        [BOARDS_FEATURE_NAME]: {
          ...boards,
          boardCfgs: upsertById(boards.boardCfgs, payload.boardCfgs),
        },
      };
    }
    const planner = s[plannerFeatureKey] as PlannerState | undefined;
    if (planner && payload.plannerDays && Object.keys(payload.plannerDays).length) {
      const days = { ...planner.days };
      for (const [day, ids] of Object.entries(payload.plannerDays)) {
        const curIds = days[day] ?? [];
        days[day] = [...curIds, ...ids.filter((id) => !curIds.includes(id))];
      }
      s = { ...s, [plannerFeatureKey]: { ...planner, days } };
    }
    if (payload.menuTree && s[menuTreeFeatureKey]) {
      s = { ...s, [menuTreeFeatureKey]: payload.menuTree };
    }

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
