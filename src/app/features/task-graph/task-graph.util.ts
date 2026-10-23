import { Task, TaskStatus } from '../tasks/task.model';

export interface TaskGraphEdge {
  /** the prerequisite */
  source: string;
  /** the task that depends on it */
  target: string;
}

export const getEffectiveStatus = (task: Task): TaskStatus => {
  if (task.isDone) return 'done';
  // isDone is the source of truth: a stale 'done' status must not show as done
  return !task.status || task.status === 'done' ? 'todo' : task.status;
};

export const smartScore = (task: Task): number => {
  const s = task.smart;
  return [
    !!s?.specific?.trim(),
    (s?.metric?.target ?? 0) > 0,
    task.timeEstimate > 0 && !!s?.confidence,
    !!s?.relevance?.trim(),
    !!task.deadlineDay,
  ].filter(Boolean).length;
};

const reaches = (adj: Map<string, string[]>, from: string, to: string): boolean => {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(adj.get(id) ?? []));
  }
  return false;
};

/**
 * Nodes are the given top-level tasks; edges to missing ids (deleted, other project,
 * archived) are ignored, and an edge that would close a cycle is skipped.
 */
export const buildGraph = (tasks: Task[]): { nodes: Task[]; edges: TaskGraphEdge[] } => {
  const nodes = tasks.filter((t) => !t.parentId);
  const ids = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, string[]>(); // prerequisite -> dependents
  const edges: TaskGraphEdge[] = [];
  for (const node of nodes) {
    for (const pre of node.dependsOnIds ?? []) {
      if (!ids.has(pre) || reaches(adj, node.id, pre)) continue;
      adj.set(pre, [...(adj.get(pre) ?? []), node.id]);
      edges.push({ source: pre, target: node.id });
    }
  }
  return { nodes, edges };
};

export const isBlocked = (task: Task, byId: Map<string, Task>): boolean =>
  (task.dependsOnIds ?? []).some((id) => {
    const pre = byId.get(id);
    return !!pre && !pre.isDone;
  });

/** True if making `prerequisiteId` a prerequisite of `taskId` would create a cycle. */
export const wouldCreateCycle = (
  tasks: Task[],
  taskId: string,
  prerequisiteId: string,
): boolean => {
  if (taskId === prerequisiteId) return true;
  const adj = new Map<string, string[]>();
  for (const t of tasks) {
    for (const pre of t.dependsOnIds ?? []) {
      adj.set(pre, [...(adj.get(pre) ?? []), t.id]);
    }
  }
  // cycle iff the prerequisite already (transitively) depends on the task
  return reaches(adj, taskId, prerequisiteId);
};

export const latestPrerequisiteDay = (
  task: Task,
  byId: Map<string, Task>,
): string | null => {
  const days = (task.dependsOnIds ?? [])
    .map((id) => byId.get(id)?.dueDay)
    .filter((d): d is string => !!d);
  return days.length ? days.reduce((a, b) => (a > b ? a : b)) : null;
};
