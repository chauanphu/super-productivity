import type { ElementDefinition } from 'cytoscape';
import { Task, TaskStatus } from '../tasks/task.model';
import { buildGraph, getEffectiveStatus, isBlocked, smartScore } from './task-graph.util';

export const toCytoscapeElements = (
  tasks: Task[],
  filter: ReadonlySet<TaskStatus>,
): ElementDefinition[] => {
  const { nodes, edges } = buildGraph(tasks);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return [
    ...nodes.map((task): ElementDefinition => {
      const status = getEffectiveStatus(task);
      const classes: string[] = [status];
      if (status === 'todo') {
        classes.push(isBlocked(task, byId) ? 'blocked' : 'ready');
      }
      if (!filter.has(status)) classes.push('dim');
      return {
        data: { id: task.id, label: `${task.title}\nSMART ${smartScore(task)}/5` },
        classes: classes.join(' '),
      };
    }),
    ...edges.map(
      (e): ElementDefinition => ({
        data: { id: `${e.source}->${e.target}`, source: e.source, target: e.target },
      }),
    ),
  ];
};
