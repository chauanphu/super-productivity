import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import { T } from '../../t.const';
import { PlannerActions } from '../planner/store/planner.actions';
import { TaskService } from '../tasks/task.service';
import { Task, TaskSmart, TaskStatus } from '../tasks/task.model';
import { getEffectiveStatus, smartScore } from './task-graph.util';
import {
  isPlanDayBeforePrerequisite,
  prerequisiteOptions,
  statusPatch,
} from './task-graph-drawer.util';

@Component({
  selector: 'task-graph-drawer',
  templateUrl: './task-graph-drawer.component.html',
  styleUrl: './task-graph-drawer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
})
export class TaskGraphDrawerComponent {
  private _taskService = inject(TaskService);
  private _store = inject(Store);

  readonly task = input.required<Task>();
  readonly projectTasks = input.required<Task[]>();
  readonly closed = output<void>();

  readonly T = T;
  readonly STATUSES: { status: TaskStatus; label: string }[] = [
    { status: 'todo', label: T.F.TASK_GRAPH.STATUS_TODO },
    { status: 'doing', label: T.F.TASK_GRAPH.STATUS_DOING },
    { status: 'pending', label: T.F.TASK_GRAPH.STATUS_PENDING },
    { status: 'done', label: T.F.TASK_GRAPH.STATUS_DONE },
  ];

  readonly status = computed(() => getEffectiveStatus(this.task()));
  readonly score = computed(() => smartScore(this.task()));
  readonly options = computed(() =>
    prerequisiteOptions(this.task(), this.projectTasks()),
  );
  readonly isPlanDayWarning = computed(() => {
    const task = this.task();
    const byId = new Map(this.projectTasks().map((t) => [t.id, t]));
    return !!task.dueDay && isPlanDayBeforePrerequisite(task, task.dueDay, byId);
  });

  setStatus(status: TaskStatus): void {
    this._taskService.update(
      this.task().id,
      statusPatch(status, this.task().pendingNote),
    );
  }

  setPendingNote(note: string): void {
    this._taskService.update(this.task().id, { pendingNote: note });
  }

  togglePrerequisite(id: string): void {
    const current = this.task().dependsOnIds ?? [];
    this._taskService.update(this.task().id, {
      dependsOnIds: current.includes(id)
        ? current.filter((x) => x !== id)
        : [...current, id],
    });
  }

  setSmart(changes: Partial<TaskSmart>): void {
    this._taskService.update(this.task().id, {
      smart: { ...this.task().smart, ...changes },
    });
  }

  setMetric(changes: Partial<NonNullable<TaskSmart['metric']>>): void {
    const metric = this.task().smart?.metric ?? { target: 0, current: 0 };
    this.setSmart({ metric: { ...metric, ...changes } });
  }

  setEstimateMinutes(minutes: string): void {
    this._taskService.update(this.task().id, {
      timeEstimate: Math.max(0, Number(minutes) || 0) * 60 * 1000,
    });
  }

  setDeadline(day: string): void {
    this._taskService.update(this.task().id, { deadlineDay: day || null });
  }

  planForDay(day: string): void {
    if (!day) return;
    this._store.dispatch(PlannerActions.planTaskForDay({ task: this.task(), day }));
  }
}
