import {
  buildMergePayload,
  diffForFirstSync,
  FirstSyncMergePayload,
} from './first-sync-merge';
import { createAppDataCompleteMock } from '../../../util/app-data-mock';
import { AppDataComplete } from '../../model/model-config';
import { DEFAULT_TASK, Task } from '../../../features/tasks/task.model';
import { Project } from '../../../features/project/project.model';
import { INBOX_PROJECT } from '../../../features/project/project.const';
import { Tag } from '../../../features/tag/tag.model';
import { TODAY_TAG } from '../../../features/tag/tag.const';
import { DEFAULT_GLOBAL_CONFIG } from '../../../features/config/default-global-config.const';
import { GlobalConfigState } from '../../../features/config/global-config.model';
import { Note } from '../../../features/note/note.model';
import {
  DEFAULT_TASK_REPEAT_CFG,
  TaskRepeatCfg,
} from '../../../features/task-repeat-cfg/task-repeat-cfg.model';
import { IssueProvider } from '../../../features/issue/issue.model';
import { TimeTrackingState } from '../../../features/time-tracking/time-tracking.model';

const task = (id: string, p: Partial<Task> = {}): Task => ({
  ...DEFAULT_TASK,
  created: 1,
  id,
  title: id,
  projectId: INBOX_PROJECT.id,
  ...p,
});

const project = (id: string, p: Partial<Project> = {}): Project => ({
  ...INBOX_PROJECT,
  id,
  title: id,
  taskIds: [],
  backlogTaskIds: [],
  noteIds: [],
  ...p,
});

const tag = (id: string, p: Partial<Tag> = {}): Tag => ({
  ...TODAY_TAG,
  id,
  title: id,
  taskIds: [],
  ...p,
});

const entities = <T extends { id: string }>(
  items: T[],
): { ids: string[]; entities: Record<string, T> } => ({
  ids: items.map((i) => i.id),
  entities: Object.fromEntries(items.map((i) => [i.id, i])),
});

const data = (
  o: {
    projects?: Project[];
    tasks?: Task[];
    tags?: Tag[];
    archive?: Task[];
    archiveOld?: Task[];
    globalConfig?: GlobalConfigState;
    notes?: Note[];
    repeatCfgs?: TaskRepeatCfg[];
    issueProviders?: IssueProvider[];
    timeTracking?: TimeTrackingState;
    archiveTimeTracking?: TimeTrackingState;
  } = {},
): AppDataComplete => {
  const m = createAppDataCompleteMock();
  return {
    ...m,
    project: entities(o.projects ?? []),
    task: { ...m.task, ...entities(o.tasks ?? []) },
    tag: entities(o.tags ?? []),
    note: { ...m.note, ...entities(o.notes ?? []) },
    taskRepeatCfg: entities(o.repeatCfgs ?? []),
    issueProvider: entities(o.issueProviders ?? []),
    timeTracking: o.timeTracking ?? { project: {}, tag: {} },
    globalConfig: o.globalConfig ?? DEFAULT_GLOBAL_CONFIG,
    archiveYoung: {
      ...m.archiveYoung,
      task: entities(o.archive ?? []),
      timeTracking: o.archiveTimeTracking ?? { project: {}, tag: {} },
    },
    archiveOld: { ...m.archiveOld, task: entities(o.archiveOld ?? []) },
  };
};

const note = (id: string, projectId: string | null): Note => ({
  id,
  projectId,
  isPinnedToToday: false,
  content: id,
  created: 1,
  modified: 1,
});
const repeatCfg = (id: string, projectId: string | null): TaskRepeatCfg => ({
  ...DEFAULT_TASK_REPEAT_CFG,
  id,
  projectId,
});
const issueProvider = (id: string, defaultProjectId: string | null): IssueProvider =>
  ({
    id,
    isEnabled: true,
    issueProviderKey: 'GITHUB',
    defaultProjectId,
  }) as IssueProvider;

// REMOTE-resolved conflict project P1 used by several tests
const conflictLocal = (extra: Parameters<typeof data>[0] = {}): AppDataComplete =>
  data({ projects: [project('P1', { title: 'Local' })], ...extra });
const conflictRemote = (extra: Parameters<typeof data>[0] = {}): AppDataComplete =>
  data({ projects: [project('P1', { title: 'Remote' })], ...extra });

const ids = (items: { id: string }[]): string[] => items.map((i) => i.id).sort();
const byId = <T extends { id: string }>(items: T[], id: string): T | undefined =>
  items.find((i) => i.id === id);

describe('first-sync-merge', () => {
  it('puts a local-only project with its tasks and subtasks into the payload', () => {
    const local = data({
      projects: [project('P1', { taskIds: ['t1'] })],
      tasks: [
        task('t1', { projectId: 'P1', subTaskIds: ['s1'] }),
        task('s1', { projectId: 'P1', parentId: 't1' }),
      ],
    });
    const remote = data();
    expect(diffForFirstSync(local, remote).conflicts).toEqual([]);
    const p = buildMergePayload(local, remote, {});
    expect(ids(p.projects)).toEqual(['P1']);
    expect(ids(p.tasks)).toEqual(['s1', 't1']);
    expect(byId(p.tasks, 't1')?.subTaskIds).toEqual(['s1']);
    expect(byId(p.tasks, 's1')?.parentId).toBe('t1');
    expect(byId(p.projects, 'P1')?.taskIds).toEqual(['t1']);
  });

  it('does not put a remote-only project into the payload', () => {
    const remote = data({
      projects: [project('R1', { taskIds: ['r1'] })],
      tasks: [task('r1', { projectId: 'R1' })],
    });
    const p = buildMergePayload(data(), remote, {});
    expect(p.projects).toEqual([]);
    expect(p.tasks).toEqual([]);
  });

  it('identical same-ID project is no conflict, even with differing modified', () => {
    const mk = (modified: number): AppDataComplete =>
      data({
        projects: [project('P1', { taskIds: ['t1'] })],
        tasks: [task('t1', { projectId: 'P1', modified })],
      });
    expect(diffForFirstSync(mk(1), mk(2)).conflicts).toEqual([]);
    const p = buildMergePayload(mk(1), mk(2), {});
    expect(p.projects).toEqual([]);
    expect(p.tasks).toEqual([]);
  });

  describe('differing same-ID project', () => {
    const local = data({
      projects: [project('P1', { title: 'Local', taskIds: ['t1'] })],
      tasks: [task('t1', { projectId: 'P1', title: 'local title' })],
    });
    const remote = data({
      projects: [project('P1', { title: 'Remote', taskIds: ['t1', 'r2'] })],
      tasks: [
        task('t1', { projectId: 'P1', title: 'remote title' }),
        task('r2', { projectId: 'P1' }),
      ],
    });

    it('is reported as conflict with the local title', () => {
      expect(diffForFirstSync(local, remote).conflicts).toEqual([
        { projectId: 'P1', title: 'Local' },
      ]);
    });

    it('LOCAL puts project and its tasks into the payload, keeping remote-only tasks listed', () => {
      const p = buildMergePayload(local, remote, { P1: 'LOCAL' });
      expect(byId(p.projects, 'P1')?.title).toBe('Local');
      expect(byId(p.projects, 'P1')?.taskIds).toEqual(['t1', 'r2']);
      expect(byId(p.tasks, 't1')?.title).toBe('local title');
      expect(byId(p.tasks, 'r2')).toBeUndefined();
    });

    it('REMOTE drops local project and its tasks', () => {
      const p = buildMergePayload(local, remote, { P1: 'REMOTE' });
      expect(p.projects).toEqual([]);
      expect(p.tasks).toEqual([]);
    });

    it('throws when the choice for a conflict is missing', () => {
      expect(() => buildMergePayload(local, remote, {})).toThrowError(/P1/);
    });
  });

  it('same title but different ID gives two separate projects without conflict', () => {
    const local = data({ projects: [project('A', { title: 'Same' })] });
    const remote = data({ projects: [project('B', { title: 'Same' })] });
    expect(diffForFirstSync(local, remote).conflicts).toEqual([]);
    expect(ids(buildMergePayload(local, remote, {}).projects)).toEqual(['A']);
  });

  describe('inbox tasks', () => {
    it('are not a project conflict and merge by ID, newer modified wins', () => {
      const local = data({
        projects: [project(INBOX_PROJECT.id, { taskIds: ['a', 'b', 'c'] })],
        tasks: [
          task('a', { title: 'local a', modified: 20 }),
          task('b', { title: 'local b', modified: 5 }),
          task('c', { title: 'local only' }),
        ],
      });
      const remote = data({
        projects: [project(INBOX_PROJECT.id, { taskIds: ['a', 'b', 'r'] })],
        tasks: [
          task('a', { title: 'remote a', modified: 10 }),
          task('b', { title: 'remote b', modified: 10 }),
          task('r'),
        ],
      });
      expect(diffForFirstSync(local, remote).conflicts).toEqual([]);
      const p = buildMergePayload(local, remote, {});
      expect(ids(p.tasks)).toEqual(['a', 'c']);
      expect(byId(p.tasks, 'a')?.title).toBe('local a');
      expect(byId(p.projects, INBOX_PROJECT.id)?.taskIds).toEqual(['a', 'b', 'r', 'c']);
    });

    it('keeps a local-only subtask attached to a remote parent', () => {
      const local = data({
        tasks: [
          task('par', { subTaskIds: ['sub'], modified: 1 }),
          task('sub', { parentId: 'par' }),
        ],
      });
      const remote = data({
        projects: [project(INBOX_PROJECT.id, { taskIds: ['par'] })],
        tasks: [task('par', { subTaskIds: [], modified: 9, title: 'remote par' })],
      });
      const p = buildMergePayload(local, remote, {});
      expect(byId(p.tasks, 'sub')?.parentId).toBe('par');
      const par = byId(p.tasks, 'par');
      expect(par?.title).toBe('remote par');
      expect(par?.subTaskIds).toEqual(['sub']);
      // subtasks are never listed in project.taskIds
      expect(byId(p.projects, INBOX_PROJECT.id)).toBeUndefined();
    });
  });

  it('unions tags by ID and keeps tag.taskIds consistent', () => {
    const local = data({
      tags: [tag('L'), tag('S', { title: 'local S' })],
      tasks: [task('t', { tagIds: ['L', 'S'] })],
    });
    const remote = data({
      tags: [tag('S', { title: 'remote S', taskIds: ['x'] }), tag('R')],
      tasks: [task('x', { tagIds: ['S'] })],
    });
    const p = buildMergePayload(local, remote, {});
    expect(ids(p.tags)).toEqual(['L', 'S']);
    expect(byId(p.tags, 'L')?.taskIds).toEqual(['t']);
    expect(byId(p.tags, 'S')?.title).toBe('remote S');
    expect(byId(p.tags, 'S')?.taskIds).toEqual(['x', 't']);
  });

  it('does not emit a remote tag that is identical after reconcile', () => {
    const shared = tag('R', { title: 'same', taskIds: ['x'] });
    const local = data({ tags: [shared], tasks: [task('x', { tagIds: ['R'] })] });
    const remote = data({ tags: [shared], tasks: [task('x', { tagIds: ['R'] })] });
    expect(buildMergePayload(local, remote, {}).tags).toEqual([]);
  });

  it('never puts TODAY into tagIds and never emits the TODAY tag', () => {
    const local = data({
      tags: [tag(TODAY_TAG.id, { taskIds: ['t'] })],
      tasks: [task('t', { tagIds: [TODAY_TAG.id, 'X'] })],
      archive: [task('arch', { tagIds: [TODAY_TAG.id] })],
    });
    const p: FirstSyncMergePayload = buildMergePayload(local, data(), {});
    expect(p.tags.map((t) => t.id)).not.toContain(TODAY_TAG.id);
    [...p.tasks, ...p.archiveTasks].forEach((t) =>
      expect(t.tagIds).not.toContain(TODAY_TAG.id),
    );
  });

  it('uses local config only when remote has none', () => {
    const localCfg: GlobalConfigState = {
      ...DEFAULT_GLOBAL_CONFIG,
      misc: { ...DEFAULT_GLOBAL_CONFIG.misc, isMinimizeToTray: true },
    };
    const local = data({ globalConfig: localCfg });
    expect(buildMergePayload(local, data(), {}).globalConfig).toBe(localCfg);
    const remoteCfg: GlobalConfigState = {
      ...DEFAULT_GLOBAL_CONFIG,
      misc: { ...DEFAULT_GLOBAL_CONFIG.misc, startOfNextDay: 4 },
    };
    expect(
      buildMergePayload(local, data({ globalConfig: remoteCfg }), {}).globalConfig,
    ).toBeNull();
  });

  it('puts only local-only archived tasks into archiveTasks', () => {
    const local = data({ archive: [task('a1'), task('a2'), task('a3')] });
    const remote = data({ archive: [task('a1')], tasks: [task('a3')] });
    expect(ids(buildMergePayload(local, remote, {}).archiveTasks)).toEqual(['a2']);
  });
  it('keeps archived tasks of a REMOTE-resolved project (archive is additive)', () => {
    const p = buildMergePayload(
      conflictLocal({ archive: [task('a1', { projectId: 'P1' })] }),
      conflictRemote(),
      { P1: 'REMOTE' },
    );
    expect(ids(p.archiveTasks)).toEqual(['a1']);
  });

  it('never re-activates a task that is archived on the remote', () => {
    const local = data({
      projects: [project('LP', { taskIds: ['x1'] })],
      tasks: [task('x1', { projectId: 'LP' }), task('x2', { modified: 99 })],
    });
    const remote = data({ archive: [task('x1')], archiveOld: [task('x2')] });
    const p = buildMergePayload(local, remote, {});
    expect(p.tasks).toEqual([]);
    expect(byId(p.projects, 'LP')?.taskIds).toEqual([]);
  });

  it('drops stale ids from reconciled containers', () => {
    const local = data({ tasks: [task('n')] });
    const remote = data({
      projects: [project(INBOX_PROJECT.id, { taskIds: ['ghost'] })],
    });
    const p = buildMergePayload(local, remote, {});
    expect(byId(p.projects, INBOX_PROJECT.id)?.taskIds).toEqual(['n']);
  });

  it('carries local-only notes and keeps pushed project noteIds', () => {
    const local = conflictLocal({
      projects: [project('LP', { noteIds: ['n1'] }), project('P1', { title: 'Local' })],
      notes: [note('n1', 'LP'), note('n2', null), note('n3', 'P1'), note('n4', null)],
    });
    const remote = conflictRemote({ notes: [note('n4', null)] });
    const p = buildMergePayload(local, remote, { P1: 'REMOTE' });
    expect(ids(p.notes)).toEqual(['n1', 'n2']);
    expect(byId(p.projects, 'LP')?.noteIds).toEqual(['n1']);
  });

  it('lists a local-only note in its existing, not-pushed remote project', () => {
    // Inbox is never a conflict/pushed project, so this is the realistic case
    const I = INBOX_PROJECT.id;
    const local = data({
      projects: [project(I, { title: 'local inbox', noteIds: ['n0', 'nl'] })],
      notes: [note('n0', I), note('nl', I)],
    });
    const remoteInbox = project(I, { title: 'remote inbox', noteIds: ['n0'] });
    const remote = data({ projects: [remoteInbox], notes: [note('n0', I)] });
    expect(diffForFirstSync(local, remote).conflicts).toEqual([]);
    const p = buildMergePayload(local, remote, {});
    expect(ids(p.notes)).toEqual(['nl']);
    expect(byId(p.projects, I)).toEqual({ ...remoteInbox, noteIds: ['n0', 'nl'] });
  });

  it('carries local-only repeat cfgs and issue providers, not those of REMOTE projects', () => {
    const local = conflictLocal({
      repeatCfgs: [repeatCfg('r1', null), repeatCfg('r2', 'P1'), repeatCfg('r3', null)],
      issueProviders: [issueProvider('i1', null), issueProvider('i2', 'P1')],
    });
    const remote = conflictRemote({
      repeatCfgs: [repeatCfg('r3', null)],
    });
    const p = buildMergePayload(local, remote, { P1: 'REMOTE' });
    expect(ids(p.taskRepeatCfgs)).toEqual(['r1']);
    expect(ids(p.issueProviders)).toEqual(['i1']);
  });

  /* eslint-disable @typescript-eslint/naming-convention -- date keys */
  it('merges time tracking entries the remote lacks, skipping REMOTE projects', () => {
    const local = conflictLocal({
      timeTracking: {
        project: { LP: { '2026-01-01': { s: 1 } }, P1: { '2026-01-01': { s: 2 } } },
        tag: { T: { '2026-01-01': { s: 3 }, '2026-01-02': { s: 4 } } },
      },
      archiveTimeTracking: { project: { LP: { '2025-01-01': { s: 5 } } }, tag: {} },
    });
    const remote = conflictRemote({
      timeTracking: { project: {}, tag: { T: { '2026-01-02': { s: 9 } } } },
    });
    const p = buildMergePayload(local, remote, { P1: 'REMOTE' });
    expect(p.timeTracking).toEqual({
      project: { LP: { '2026-01-01': { s: 1 }, '2025-01-01': { s: 5 } } },
      tag: { T: { '2026-01-01': { s: 3 } } },
    });
  });
  /* eslint-enable @typescript-eslint/naming-convention */
});
