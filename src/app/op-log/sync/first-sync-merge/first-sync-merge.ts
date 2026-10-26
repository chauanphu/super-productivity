import { AppDataComplete } from '../../model/model-config';
import { Project } from '../../../features/project/project.model';
import { Task, TaskCopy } from '../../../features/tasks/task.model';
import { Tag } from '../../../features/tag/tag.model';
import { GlobalConfigState } from '../../../features/config/global-config.model';
import { INBOX_PROJECT } from '../../../features/project/project.const';
import { TODAY_TAG } from '../../../features/tag/tag.const';
import { DEFAULT_GLOBAL_CONFIG } from '../../../features/config/default-global-config.const';
import { Note } from '../../../features/note/note.model';
import { TaskRepeatCfg } from '../../../features/task-repeat-cfg/task-repeat-cfg.model';
import { IssueProvider } from '../../../features/issue/issue.model';
import { TimeTrackingState } from '../../../features/time-tracking/time-tracking.model';

/**
 * Pure first-login merge (spec decision 3). Entities are matched by ID only.
 * The payload contains only what has to be written ON TOP of the remote state.
 */

export type MergeChoice = 'LOCAL' | 'REMOTE';
export type ProjectConflict = { projectId: string; title: string };
export type FirstSyncMergePayload = {
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  notes: Note[];
  taskRepeatCfgs: TaskRepeatCfg[];
  issueProviders: IssueProvider[];
  /** only (context, date) entries the remote lacks */
  timeTracking: TimeTrackingState;
  globalConfig: GlobalConfigState | null;
  archiveTasks: TaskCopy[];
};

type EntityMap<T> = { entities?: Record<string, T | undefined> } | undefined;

// remote comes from an untyped snapshot, so slices may be missing
const values = <T>(s: EntityMap<T>): T[] =>
  Object.values(s?.entities ?? {}).filter((v): v is T => !!v);
const map = <T>(s: EntityMap<T>): Record<string, T | undefined> => s?.entities ?? {};

const stableJson = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : val,
  );

const withoutModified = <T extends { modified?: number }>(e: T): T => ({
  ...e,
  modified: undefined, // dropped by JSON.stringify
});

/** "Real" project = has an entity locally and is not the Inbox (Inbox tasks merge by ID). */
const isRealProjectId = (
  pid: string | undefined,
  projects: Record<string, Project | undefined>,
): pid is string => !!pid && pid !== INBOX_PROJECT.id && !!projects[pid];

/**
 * Content = project entity + all tasks with that projectId (incl. subtasks and
 * backlog), tasks sorted by id, key order ignored, array order kept (ordering is
 * content). Only `task.modified` is ignored: it is a pure "last edited at" stamp
 * and would otherwise make two identical copies look different.
 */
const projectContent = (d: AppDataComplete, p: Project): string =>
  stableJson({
    project: p,
    tasks: values(d.task)
      .filter((t) => t.projectId === p.id)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .map(withoutModified),
  });

export const diffForFirstSync = (
  local: AppDataComplete,
  remote: AppDataComplete,
): { conflicts: ProjectConflict[] } => {
  const remoteProjects = map(remote.project);
  return {
    conflicts: values(local.project)
      .filter((p) => p.id !== INBOX_PROJECT.id)
      .filter((p) => {
        const r = remoteProjects[p.id];
        return !!r && projectContent(local, p) !== projectContent(remote, r);
      })
      .map((p) => ({ projectId: p.id, title: p.title })),
  };
};

const stripToday = <T extends Task>(t: T): T =>
  t.tagIds.includes(TODAY_TAG.id)
    ? { ...t, tagIds: t.tagIds.filter((id) => id !== TODAY_TAG.id) }
    : t;

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

export const buildMergePayload = (
  local: AppDataComplete,
  remote: AppDataComplete,
  choices: Record<string, MergeChoice>,
): FirstSyncMergePayload => {
  const conflicts = diffForFirstSync(local, remote).conflicts;
  for (const c of conflicts) {
    if (!choices[c.projectId]) {
      throw new Error(`first-sync-merge: missing choice for project ${c.projectId}`);
    }
  }
  const conflictIds = new Set(conflicts.map((c) => c.projectId));
  const isRemoteChosen = (pid: string | null | undefined | false): boolean =>
    !!pid && conflictIds.has(pid) && choices[pid] === 'REMOTE';
  const localProjects = map(local.project);
  const remoteProjects = map(remote.project);
  const remoteTasks = map(remote.task);
  const remoteArchived = {
    ...map(remote.archiveYoung?.task),
    ...map(remote.archiveOld?.task),
  };

  // --- projects + tasks ---
  const pushedProjects = new Map<string, Project>();
  for (const p of values(local.project)) {
    if (p.id === INBOX_PROJECT.id) continue;
    if (!remoteProjects[p.id] || (conflictIds.has(p.id) && choices[p.id] === 'LOCAL')) {
      pushedProjects.set(p.id, p);
    }
  }

  const payloadTasks = new Map<string, Task>();
  for (const t of values(local.task)) {
    // remote archive wins: never re-activate a task archived on another device
    if (remoteArchived[t.id]) continue;
    const isPushed = isRealProjectId(t.projectId, localProjects)
      ? pushedProjects.has(t.projectId)
      : // Inbox / orphan: by ID, newer `modified` wins, remote wins ties (nothing to write)
        (t.modified ?? 0) > (remoteTasks[t.id]?.modified ?? 0) || !remoteTasks[t.id];
    if (isPushed) payloadTasks.set(t.id, stripToday(t));
  }

  const finalTasks: Record<string, Task | undefined> = {
    ...remoteTasks,
    ...Object.fromEntries(payloadTasks),
  };

  // e.g. Inbox missing on remote: bring the local entity along
  for (const t of payloadTasks.values()) {
    const lp = localProjects[t.projectId];
    if (lp && !remoteProjects[t.projectId] && !pushedProjects.has(lp.id)) {
      pushedProjects.set(lp.id, lp);
    }
  }

  // --- keep containers consistent with the final (remote + payload) task set ---
  // An id is kept only if its final task exists and belongs there; missing members
  // are appended. So with LOCAL, remote-only tasks of that project stay listed
  // (the payload is upsert-only).
  const finalTaskList = Object.values(finalTasks).filter((t): t is Task => !!t);
  const keep = (listed: readonly string[], belongs: (t: Task) => boolean): string[] =>
    listed.filter((id) => {
      const t = finalTasks[id];
      return !!t && belongs(t);
    });
  const reconcile = (
    listed: readonly string[],
    belongs: (t: Task) => boolean,
  ): string[] => {
    const kept = keep(listed, belongs);
    const members = finalTaskList.filter(belongs).map((t) => t.id);
    return [...kept, ...members.filter((id) => !kept.includes(id))];
  };

  // --- related entities: local-only by ID, not for REMOTE-chosen projects ---
  const localOnly = <T extends { id: string }>(
    l: EntityMap<T>,
    r: EntityMap<T>,
    projectIdOf: (e: T) => string | null | undefined | false,
  ): T[] => {
    const rm = map(r);
    return values(l).filter((e) => !rm[e.id] && !isRemoteChosen(projectIdOf(e)));
  };
  const notes = localOnly(local.note, remote.note, (n) => n.projectId);
  const taskRepeatCfgs = localOnly(
    local.taskRepeatCfg,
    remote.taskRepeatCfg,
    (c) => c.projectId,
  );
  const issueProviders = localOnly(
    local.issueProvider,
    remote.issueProvider,
    (i) => i.defaultProjectId,
  );

  const projects: Project[] = [];
  const allProjects = { ...remoteProjects, ...Object.fromEntries(pushedProjects) };
  for (const p of Object.values(allProjects)) {
    if (!p) continue;
    const belongs = (t: Task): boolean => t.projectId === p.id && !t.parentId;
    const backlogTaskIds = keep(p.backlogTaskIds, belongs);
    const taskIds = keep(p.taskIds, belongs);
    const localBacklog = localProjects[p.id]?.backlogTaskIds ?? [];
    for (const t of finalTaskList.filter(belongs)) {
      if (taskIds.includes(t.id) || backlogTaskIds.includes(t.id)) continue;
      (localBacklog.includes(t.id) ? backlogTaskIds : taskIds).push(t.id);
    }
    // pushed projects carry their local noteIds; others get payload notes appended
    const isPushed = pushedProjects.has(p.id);
    const noteIds = isPushed
      ? p.noteIds
      : [
          ...p.noteIds,
          ...notes
            .filter((n) => n.projectId === p.id && !p.noteIds.includes(n.id))
            .map((n) => n.id),
        ];
    if (
      isPushed ||
      !sameIds(taskIds, p.taskIds) ||
      !sameIds(backlogTaskIds, p.backlogTaskIds) ||
      !sameIds(noteIds, p.noteIds)
    ) {
      projects.push({ ...p, taskIds, backlogTaskIds, noteIds });
    }
  }

  for (const parent of finalTaskList) {
    const subTaskIds = reconcile(parent.subTaskIds, (t) => t.parentId === parent.id);
    if (!sameIds(subTaskIds, parent.subTaskIds)) {
      payloadTasks.set(parent.id, { ...parent, subTaskIds });
    }
  }

  // --- tags: union by ID, remote entity wins; TODAY is virtual and never emitted ---
  const remoteTags = map(remote.tag);
  const tags: Tag[] = [];
  const localOnlyTags = values(local.tag).filter((t) => !remoteTags[t.id]);
  for (const tag of [...values(remote.tag), ...localOnlyTags]) {
    if (tag.id === TODAY_TAG.id) continue;
    const taskIds = reconcile(tag.taskIds, (t) => t.tagIds.includes(tag.id));
    if (!remoteTags[tag.id] || !sameIds(taskIds, tag.taskIds)) {
      tags.push({ ...tag, taskIds });
    }
  }

  // --- archive: local-only by ID, additive (also for REMOTE-chosen projects) ---
  const archiveTasks: TaskCopy[] = [
    ...values(local.archiveYoung?.task),
    ...values(local.archiveOld?.task),
  ]
    .filter((t) => !remoteArchived[t.id] && !remoteTasks[t.id])
    .map(stripToday);

  // --- time tracking: (context, date) entries the remote lacks (active + archives) ---
  const ttSources = (d: AppDataComplete): (TimeTrackingState | undefined)[] => [
    d.timeTracking,
    d.archiveYoung?.timeTracking,
    d.archiveOld?.timeTracking,
  ];
  const timeTracking: TimeTrackingState = { project: {}, tag: {} };
  for (const kind of ['project', 'tag'] as const) {
    const remoteHas = (ctx: string, date: string): boolean =>
      ttSources(remote).some((s) => !!s?.[kind]?.[ctx]?.[date]);
    for (const src of ttSources(local)) {
      for (const [ctx, byDate] of Object.entries(src?.[kind] ?? {})) {
        if (kind === 'project' && isRemoteChosen(ctx)) continue;
        for (const [date, entry] of Object.entries(byDate ?? {})) {
          if (remoteHas(ctx, date) || timeTracking[kind][ctx]?.[date]) continue;
          timeTracking[kind][ctx] = { ...timeTracking[kind][ctx], [date]: entry };
        }
      }
    }
  }

  // "remote has config" = present and not identical to DEFAULT_GLOBAL_CONFIG
  // (a fresh account yields defaults). shortcut: an account whose user kept every
  // default is treated as "no config"; upgrade if the server exposes a presence marker.
  // The `sync` section is pushed as-is: credentials live in the credential store, and
  // receivers keep their own isEnabled/syncProvider/isEncryptionEnabled (loadAllData reducer).
  const remoteHasConfig =
    !!remote.globalConfig &&
    stableJson(remote.globalConfig) !== stableJson(DEFAULT_GLOBAL_CONFIG);

  return {
    projects,
    tasks: [...payloadTasks.values()],
    tags,
    notes,
    taskRepeatCfgs,
    issueProviders,
    timeTracking,
    globalConfig: remoteHasConfig ? null : local.globalConfig,
    archiveTasks,
  };
};
