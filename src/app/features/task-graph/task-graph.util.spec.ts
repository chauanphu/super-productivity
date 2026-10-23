import { DEFAULT_TASK, Task } from '../tasks/task.model';
import {
  buildGraph,
  getEffectiveStatus,
  isBlocked,
  latestPrerequisiteDay,
  smartScore,
  wouldCreateCycle,
} from './task-graph.util';

const t = (id: string, extra: Partial<Task> = {}): Task =>
  ({ ...DEFAULT_TASK, id, title: id, projectId: 'P', ...extra }) as Task;

describe('task-graph.util', () => {
  describe('getEffectiveStatus', () => {
    it('returns done when isDone even if status is doing', () => {
      expect(getEffectiveStatus(t('a', { isDone: true, status: 'doing' }))).toBe('done');
    });

    it('defaults to todo', () => {
      expect(getEffectiveStatus(t('a'))).toBe('todo');
    });

    it('does not show done when isDone was unset again', () => {
      expect(getEffectiveStatus(t('a', { status: 'done', isDone: false }))).toBe('todo');
    });
  });

  describe('smartScore', () => {
    it('is 0 for a bare task', () => {
      expect(smartScore(t('a'))).toBe(0);
    });

    it('is 5 when every letter is filled', () => {
      const full = t('a', {
        timeEstimate: 60,
        deadlineDay: '2026-11-01',
        smart: {
          specific: 'x',
          metric: { target: 10, current: 0 },
          confidence: 3,
          relevance: 'goal',
        },
      });
      expect(smartScore(full)).toBe(5);
    });

    it('needs both estimate and confidence for A, and target > 0 for M', () => {
      expect(
        smartScore(
          t('a', { timeEstimate: 60, smart: { metric: { target: 0, current: 0 } } }),
        ),
      ).toBe(0);
    });
  });

  describe('buildGraph', () => {
    it('keeps edges between present tasks (source = prerequisite)', () => {
      const g = buildGraph([t('a'), t('b', { dependsOnIds: ['a'] })]);
      expect(g.edges).toEqual([{ source: 'a', target: 'b' }]);
    });

    it('drops subtasks, archived-away and dangling ids', () => {
      const g = buildGraph([
        t('a'),
        t('sub', { parentId: 'a' }),
        t('b', { dependsOnIds: ['gone', 'sub', 'a'] }),
      ]);
      expect(g.nodes.map((n) => n.id)).toEqual(['a', 'b']);
      expect(g.edges).toEqual([{ source: 'a', target: 'b' }]);
    });

    it('ignores the edge that closes a cycle', () => {
      const g = buildGraph([
        t('a', { dependsOnIds: ['b'] }),
        t('b', { dependsOnIds: ['a'] }),
      ]);
      expect(g.edges.length).toBe(1);
    });
  });

  describe('isBlocked', () => {
    it('is true while a prerequisite is not done', () => {
      const a = t('a');
      const b = t('b', { dependsOnIds: ['a'] });
      const byId = new Map([a, b].map((x) => [x.id, x]));
      expect(isBlocked(b, byId)).toBe(true);
    });

    it('is false when all prerequisites are done or missing', () => {
      const a = t('a', { isDone: true });
      const b = t('b', { dependsOnIds: ['a', 'gone'] });
      const byId = new Map([a, b].map((x) => [x.id, x]));
      expect(isBlocked(b, byId)).toBe(false);
    });
  });

  describe('wouldCreateCycle', () => {
    const tasks = [
      t('a'),
      t('b', { dependsOnIds: ['a'] }),
      t('c', { dependsOnIds: ['b'] }),
    ];

    it('detects self dependency', () => {
      expect(wouldCreateCycle(tasks, 'a', 'a')).toBe(true);
    });

    it('detects a transitive cycle', () => {
      expect(wouldCreateCycle(tasks, 'a', 'c')).toBe(true);
    });

    it('allows an independent edge', () => {
      expect(wouldCreateCycle(tasks, 'c', 'a')).toBe(false);
    });
  });

  describe('latestPrerequisiteDay', () => {
    it('returns the latest dueDay of prerequisites, null when none', () => {
      const a = t('a', { dueDay: '2026-11-02' });
      const b = t('b', { dueDay: '2026-11-05' });
      const c = t('c', { dependsOnIds: ['a', 'b'] });
      const byId = new Map([a, b, c].map((x) => [x.id, x]));
      expect(latestPrerequisiteDay(c, byId)).toBe('2026-11-05');
      expect(latestPrerequisiteDay(a, byId)).toBeNull();
    });
  });
});
