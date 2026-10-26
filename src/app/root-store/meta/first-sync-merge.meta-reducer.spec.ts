/* eslint-disable @typescript-eslint/naming-convention */ // date keys like '2026-01-01'
import { Action } from '@ngrx/store';
import { firstSyncMergeMetaReducer } from './first-sync-merge.meta-reducer';
import { applyFirstSyncMerge } from './first-sync-merge.actions';
import { FirstSyncMergePayload } from '../../op-log/sync/first-sync-merge/first-sync-merge';
import {
  createBaseState,
  createMockProject,
  createMockTag,
  createMockTask,
} from './task-shared-meta-reducers/test-utils';
import { RootState } from '../root-state';
import { PROJECT_FEATURE_NAME } from '../../features/project/store/project.reducer';
import { TASK_FEATURE_NAME } from '../../features/tasks/store/task.reducer';
import { TAG_FEATURE_NAME } from '../../features/tag/store/tag.reducer';
import { NOTE_FEATURE_NAME } from '../../features/note/store/note.reducer';
import { CONFIG_FEATURE_NAME } from '../../features/config/store/global-config.reducer';
import { TIME_TRACKING_FEATURE_KEY } from '../../features/time-tracking/store/time-tracking.reducer';
import { TASK_REPEAT_CFG_FEATURE_NAME } from '../../features/task-repeat-cfg/store/task-repeat-cfg.selectors';
import { ISSUE_PROVIDER_FEATURE_KEY } from '../../features/issue/store/issue-provider.reducer';
import { DEFAULT_GLOBAL_CONFIG } from '../../features/config/default-global-config.const';
import { GlobalConfigState } from '../../features/config/global-config.model';
import { Note } from '../../features/note/note.model';
import { TaskRepeatCfg } from '../../features/task-repeat-cfg/task-repeat-cfg.model';
import { IssueProvider } from '../../features/issue/issue.model';
import { isPersistentAction } from '../../op-log/core/persistent-action.interface';
import { isArchiveAffectingAction } from '../../op-log/apply/archive-operation-handler.service';
import { convertOpToAction } from '../../op-log/apply/operation-converter.util';
import { ActionType, Operation, OpType } from '../../op-log/core/operation.types';

type State = RootState & Record<string, unknown>;

const emptyPayload = (): FirstSyncMergePayload => ({
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

const localSync = {
  ...DEFAULT_GLOBAL_CONFIG.sync,
  isEnabled: true,
  isEncryptionEnabled: true,
};

const createState = (): State => {
  const base = createBaseState();
  const projectA = createMockProject({ id: 'A', title: 'A' });
  const projectC = createMockProject({ id: 'C', title: 'old C' });
  return {
    ...base,
    [PROJECT_FEATURE_NAME]: {
      ids: ['A', 'C'],
      entities: { A: projectA, C: projectC },
    },
    [TAG_FEATURE_NAME]: {
      ...base[TAG_FEATURE_NAME],
      entities: {
        ...base[TAG_FEATURE_NAME].entities,
        TODAY: { ...base[TAG_FEATURE_NAME].entities.TODAY!, taskIds: ['t0'] },
      },
    },
    [NOTE_FEATURE_NAME]: { ids: [], entities: {}, todayOrder: [] },
    [TASK_REPEAT_CFG_FEATURE_NAME]: { ids: [], entities: {} },
    [ISSUE_PROVIDER_FEATURE_KEY]: { ids: [], entities: {} },
    [TIME_TRACKING_FEATURE_KEY]: {
      project: { A: { '2026-01-01': { s: 1, e: 2 } } },
      tag: {},
    },
    [CONFIG_FEATURE_NAME]: { ...DEFAULT_GLOBAL_CONFIG, sync: localSync },
  } as State;
};

describe('firstSyncMergeMetaReducer', () => {
  const inner = jasmine
    .createSpy('reducer')
    .and.callFake((s: unknown, _a: Action) => s as State);
  const reducer = firstSyncMergeMetaReducer(inner);
  const apply = (state: State, payload: FirstSyncMergePayload): State =>
    reducer(state, applyFirstSyncMerge({ payload })) as State;

  it('adds a new project and its tasks and leaves others unchanged', () => {
    const state = createState();
    const payload = {
      ...emptyPayload(),
      projects: [createMockProject({ id: 'B', taskIds: ['t1', 't2'] })],
      tasks: [
        createMockTask({ id: 't1', projectId: 'B', tagIds: [] }),
        createMockTask({ id: 't2', projectId: 'B', tagIds: [] }),
      ],
    };
    const r = apply(state, payload);
    expect(r[PROJECT_FEATURE_NAME].entities.B!.taskIds).toEqual(['t1', 't2']);
    expect(r[TASK_FEATURE_NAME].entities.t1!.projectId).toBe('B');
    expect(r[TASK_FEATURE_NAME].entities.t2).toBeDefined();
    expect(r[PROJECT_FEATURE_NAME].entities.A).toBe(
      state[PROJECT_FEATURE_NAME].entities.A,
    );
  });

  it('replaces an existing project with the same id', () => {
    const c = createMockProject({ id: 'C', title: 'new C', taskIds: ['x'] });
    const r = apply(createState(), { ...emptyPayload(), projects: [c] });
    expect(r[PROJECT_FEATURE_NAME].entities.C).toEqual(c);
    expect(r[PROJECT_FEATURE_NAME].ids).toEqual(['A', 'C']);
  });

  it('keeps TODAY_TAG.taskIds and never writes TODAY into tagIds', () => {
    const payload = {
      ...emptyPayload(),
      tasks: [createMockTask({ id: 't1', tagIds: ['tag1', 'TODAY'] })],
      tags: [
        createMockTag({ id: 'tag1', taskIds: ['t1'] }),
        createMockTag({ id: 'TODAY', taskIds: [] }),
      ],
    };
    const r = apply(createState(), payload);
    expect(r[TAG_FEATURE_NAME].entities.TODAY!.taskIds).toEqual(['t0']);
    expect(r[TASK_FEATURE_NAME].entities.t1!.tagIds).toEqual(['tag1']);
    expect(r[TAG_FEATURE_NAME].entities.tag1!.taskIds).toEqual(['t1']);
  });

  it('applies globalConfig but keeps this device sync section', () => {
    const incoming: GlobalConfigState = {
      ...DEFAULT_GLOBAL_CONFIG,
      misc: { ...DEFAULT_GLOBAL_CONFIG.misc, isConfirmBeforeExit: true },
      sync: { ...DEFAULT_GLOBAL_CONFIG.sync, isEnabled: false },
    };
    const r = apply(createState(), { ...emptyPayload(), globalConfig: incoming });
    expect(r[CONFIG_FEATURE_NAME].misc.isConfirmBeforeExit).toBe(true);
    expect(r[CONFIG_FEATURE_NAME].sync).toEqual(localSync);
  });

  it('leaves config alone when globalConfig is null', () => {
    const state = createState();
    const r = apply(state, emptyPayload());
    expect(r[CONFIG_FEATURE_NAME]).toBe(state[CONFIG_FEATURE_NAME]);
  });

  it('upserts notes, repeat cfgs, issue providers and time tracking', () => {
    const payload: FirstSyncMergePayload = {
      ...emptyPayload(),
      notes: [{ id: 'n1', projectId: 'A' } as Note],
      taskRepeatCfgs: [{ id: 'r1', projectId: 'A' } as TaskRepeatCfg],
      issueProviders: [{ id: 'i1' } as IssueProvider],
      timeTracking: {
        project: { A: { '2026-01-02': { s: 3 } }, B: { '2026-01-03': { e: 4 } } },
        tag: { tag1: { '2026-01-04': { b: 1 } } },
      },
    };
    const r = apply(createState(), payload);
    expect((r[NOTE_FEATURE_NAME].entities.n1 as Note).projectId).toBe('A');
    const rc = r[TASK_REPEAT_CFG_FEATURE_NAME] as { entities: Record<string, unknown> };
    expect(rc.entities.r1).toBeDefined();
    const ip = r[ISSUE_PROVIDER_FEATURE_KEY] as { entities: Record<string, unknown> };
    expect(ip.entities.i1).toBeDefined();
    expect(r[TIME_TRACKING_FEATURE_KEY]).toEqual({
      project: {
        A: { '2026-01-01': { s: 1, e: 2 }, '2026-01-02': { s: 3 } },
        B: { '2026-01-03': { e: 4 } },
      },
      tag: { tag1: { '2026-01-04': { b: 1 } } },
    });
  });

  it('is idempotent (replay safe)', () => {
    const payload: FirstSyncMergePayload = {
      ...emptyPayload(),
      projects: [createMockProject({ id: 'B' })],
      tasks: [createMockTask({ id: 't1', projectId: 'B', tagIds: ['TODAY'] })],
      notes: [{ id: 'n1' } as Note],
      timeTracking: { project: { B: { '2026-01-02': { s: 3 } } }, tag: {} },
      globalConfig: DEFAULT_GLOBAL_CONFIG,
    };
    const once = apply(createState(), payload);
    expect(apply(once, payload)).toEqual(once);
  });

  it('passes other actions through untouched', () => {
    const state = createState();
    expect(reducer(state, { type: 'other' })).toBe(state);
  });
});

describe('applyFirstSyncMerge action', () => {
  it('is persistent, archive-affecting and registered', () => {
    const action = applyFirstSyncMerge({ payload: emptyPayload() });
    expect(isPersistentAction(action)).toBe(true);
    expect(isArchiveAffectingAction(action)).toBe(true);
    expect(action.meta.entityType).toBe('ALL');
    expect(action.meta.opType).toBe(OpType.Batch);
    expect(Object.values(ActionType)).toContain(action.type as ActionType);
  });

  it('round-trips through an operation for remote replay', () => {
    const payload = { ...emptyPayload(), projects: [createMockProject({ id: 'B' })] };
    const op = {
      actionType: applyFirstSyncMerge.type,
      opType: OpType.Batch,
      entityType: 'ALL',
      payload: { actionPayload: { payload }, entityChanges: [] },
    } as unknown as Operation;
    const action = convertOpToAction(op);
    expect(action.type).toBe(applyFirstSyncMerge.type);
    expect(action.payload).toEqual(payload);
    expect(action.meta.isRemote).toBe(true);
  });
});
