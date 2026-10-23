import { DEFAULT_TASK, Task, TaskStatus } from '../tasks/task.model';
import { toCytoscapeElements } from './task-graph-elements';

const t = (id: string, extra: Partial<Task> = {}): Task =>
  ({ ...DEFAULT_TASK, id, title: id, projectId: 'P', ...extra }) as Task;

const ALL = new Set<TaskStatus>(['todo', 'doing', 'done', 'pending']);
const nodeById = (
  els: ReturnType<typeof toCytoscapeElements>,
  id: string,
): ReturnType<typeof toCytoscapeElements>[number] => els.find((e) => e.data.id === id)!;

describe('toCytoscapeElements', () => {
  it('emits one node per top-level task plus edges', () => {
    const els = toCytoscapeElements(
      [t('a'), t('sub', { parentId: 'a' }), t('b', { dependsOnIds: ['a'] })],
      ALL,
    );
    expect(els.filter((e) => !e.data.source).length).toBe(2);
    expect(els.filter((e) => !!e.data.source).length).toBe(1);
  });

  it('marks a todo task blocked while a prerequisite is open, ready otherwise', () => {
    const open = toCytoscapeElements([t('a'), t('b', { dependsOnIds: ['a'] })], ALL);
    expect(nodeById(open, 'b').classes).toContain('blocked');
    expect(nodeById(open, 'a').classes).toContain('ready');

    const done = toCytoscapeElements(
      [t('a', { isDone: true }), t('b', { dependsOnIds: ['a'] })],
      ALL,
    );
    expect(nodeById(done, 'b').classes).toContain('ready');
  });

  it('dims nodes outside the status filter', () => {
    const els = toCytoscapeElements(
      [t('a', { status: 'doing' }), t('b')],
      new Set<TaskStatus>(['doing']),
    );
    expect(nodeById(els, 'a').classes).not.toContain('dim');
    expect(nodeById(els, 'b').classes).toContain('dim');
  });

  it('shows the SMART score in the label', () => {
    const els = toCytoscapeElements(
      [t('a', { deadlineDay: '2026-11-01', smart: { specific: 'x' } })],
      ALL,
    );
    expect(nodeById(els, 'a').data.label).toContain('SMART 2/5');
  });
  it('truncates very long titles and marks status with a glyph', () => {
    const long = 'x'.repeat(80);
    const els = toCytoscapeElements(
      [
        t('a', { title: long, isDone: true }),
        t('b', { title: 'short', status: 'doing' }),
      ],
      ALL,
    );
    expect(nodeById(els, 'a').data.label.split('\n')[0].length).toBeLessThan(52);
    expect(nodeById(els, 'a').data.label).toContain('✓');
    expect(nodeById(els, 'a').data.label).toContain('…');
    expect(nodeById(els, 'b').data.label).toContain('◐');
  });
});
