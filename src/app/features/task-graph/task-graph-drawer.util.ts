import { Task, TaskStatus } from '../tasks/task.model';
import { latestPrerequisiteDay, wouldCreateCycle } from './task-graph.util';

export const statusPatch = (status: TaskStatus, pendingNote = ''): Partial<Task> => ({
  status,
  isDone: status === 'done',
  pendingNote: status === 'pending' ? pendingNote : '',
});

/** Tasks that can be picked as prerequisite of `task` without a cycle. */
export const prerequisiteOptions = (task: Task, projectTasks: Task[]): Task[] =>
  projectTasks.filter(
    (t) => !t.parentId && !wouldCreateCycle(projectTasks, task.id, t.id),
  );

export const isPlanDayBeforePrerequisite = (
  task: Task,
  day: string,
  byId: Map<string, Task>,
): boolean => {
  const latest = latestPrerequisiteDay(task, byId);
  return !!latest && day < latest;
};
