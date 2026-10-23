import { DEFAULT_TASK, Task } from '../tasks/task.model';
import {
  isPlanDayBeforePrerequisite,
  prerequisiteOptions,
  statusPatch,
} from './task-graph-drawer.util';

const t = (id: string, extra: Partial<Task> = {}): Task =>
  ({ ...DEFAULT_TASK, id, title: id, projectId: 'P', ...extra }) as Task;

describe('task-graph-drawer.util', () => {
  describe('statusPatch', () => {
    it('done sets isDone', () => {
      expect(statusPatch('done')).toEqual(jasmine.objectContaining({ isDone: true }));
    });

    it('doing clears isDone', () => {
      expect(statusPatch('doing').isDone).toBe(false);
    });

    it('keeps the note only for pending', () => {
      expect(statusPatch('pending', 'wait for review').pendingNote).toBe(
        'wait for review',
      );
      expect(statusPatch('todo', 'old note').pendingNote).toBe('');
    });
  });

  describe('prerequisiteOptions', () => {
    it('excludes itself, subtasks and cycle-creating tasks', () => {
      const a = t('a');
      const b = t('b', { dependsOnIds: ['a'] });
      const c = t('c');
      const sub = t('sub', { parentId: 'c' });
      expect(prerequisiteOptions(a, [a, b, c, sub]).map((x) => x.id)).toEqual(['c']);
    });
  });

  describe('isPlanDayBeforePrerequisite', () => {
    it('is true only when the day precedes the latest prerequisite day', () => {
      const a = t('a', { dueDay: '2026-11-05' });
      const b = t('b', { dependsOnIds: ['a'] });
      const byId = new Map([a, b].map((x) => [x.id, x]));
      expect(isPlanDayBeforePrerequisite(b, '2026-11-04', byId)).toBe(true);
      expect(isPlanDayBeforePrerequisite(b, '2026-11-05', byId)).toBe(false);
      expect(isPlanDayBeforePrerequisite(a, '2026-11-01', byId)).toBe(false);
    });
  });
});
