import type { ElementDefinition } from 'cytoscape';
import { Task, TaskStatus } from '../tasks/task.model';
import { buildGraph, getEffectiveStatus, isBlocked } from './task-graph.util';

const MAX_TITLE_LENGTH = 48;
// status is also shown as a glyph so it never relies on colour alone
const STATUS_GLYPH: Record<TaskStatus, string> = {
  todo: '',
  doing: '◐ ',
  pending: '‖ ',
  done: '✓ ',
};

const shortTitle = (title: string): string =>
  title.length > MAX_TITLE_LENGTH ? `${title.slice(0, MAX_TITLE_LENGTH - 1)}…` : title;

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
        data: {
          id: task.id,
          label: `${STATUS_GLYPH[status]}${shortTitle(task.title)}`,
        },
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
