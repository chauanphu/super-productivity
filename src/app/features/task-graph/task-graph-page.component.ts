import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { map } from 'rxjs/operators';
import { ProjectService } from '../project/project.service';
import { selectAllTasks } from '../tasks/store/task.selectors';
import { Task, TaskStatus } from '../tasks/task.model';
import { T } from '../../t.const';
import { toCytoscapeElements } from './task-graph-elements';
import { TaskGraphDrawerComponent } from './task-graph-drawer.component';

cytoscape.use(dagre);

const STATUSES: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: T.F.TASK_GRAPH.STATUS_TODO },
  { status: 'doing', label: T.F.TASK_GRAPH.STATUS_DOING },
  { status: 'pending', label: T.F.TASK_GRAPH.STATUS_PENDING },
  { status: 'done', label: T.F.TASK_GRAPH.STATUS_DONE },
];

/* eslint-disable @typescript-eslint/naming-convention */
// Cytoscape style properties are kebab-case by API
const STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      shape: 'round-rectangle',
      label: 'data(label)',
      'text-wrap': 'wrap',
      'text-valign': 'center',
      'font-size': 12,
      color: '#222',
      width: 'label',
      height: 'label',
      padding: '10px',
      'background-color': '#cfd8dc',
      'border-width': 1,
      'border-color': '#78909c',
    },
  },
  { selector: 'node.doing', style: { 'background-color': '#ffcc80' } },
  { selector: 'node.done', style: { 'background-color': '#a5d6a7' } },
  { selector: 'node.pending', style: { 'background-color': '#ce93d8' } },
  {
    selector: 'node.blocked',
    style: { 'border-style': 'dashed', 'background-opacity': 0.5 },
  },
  {
    selector: 'node.ready',
    style: { 'border-width': 3, 'border-color': '#1e88e5' },
  },
  { selector: 'node.dim', style: { opacity: 0.25 } },
  {
    selector: 'node:selected',
    style: { 'overlay-color': '#1e88e5', 'overlay-opacity': 0.2 },
  },
  {
    selector: 'edge',
    style: {
      width: 1.5,
      'line-color': '#90a4ae',
      'target-arrow-color': '#90a4ae',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
    },
  },
];

/* eslint-enable @typescript-eslint/naming-convention */

@Component({
  selector: 'task-graph-page',
  templateUrl: './task-graph-page.component.html',
  styleUrl: './task-graph-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, TaskGraphDrawerComponent],
})
export class TaskGraphPageComponent {
  private _store = inject(Store);
  private _route = inject(ActivatedRoute);
  private _router = inject(Router);

  readonly T = T;
  readonly STATUSES = STATUSES;
  readonly projectService = inject(ProjectService);

  readonly projectId = toSignal(
    this._route.parent!.paramMap.pipe(map((p) => p.get('id') as string)),
    { requireSync: true },
  );
  private _allTasks = toSignal(this._store.select(selectAllTasks), { initialValue: [] });
  readonly tasks = computed<Task[]>(() =>
    this._allTasks().filter((t) => t.projectId === this.projectId()),
  );
  readonly statusFilter = signal<ReadonlySet<TaskStatus>>(
    new Set(STATUSES.map((s) => s.status)),
  );
  readonly selectedId = signal<string | null>(null);
  readonly selectedTask = computed(
    () => this.tasks().find((t) => t.id === this.selectedId()) ?? null,
  );

  private _container = viewChild.required<ElementRef<HTMLElement>>('container');
  private _cy?: cytoscape.Core;

  constructor() {
    afterNextRender(() => {
      this._cy = cytoscape({
        container: this._container().nativeElement,
        style: STYLE,
        userZoomingEnabled: true,
        maxZoom: 1.2, // keep a graph with few nodes from being fitted to huge size
        autoungrabify: true, // read-only: nodes cannot be dragged
      });
      this._cy.on('tap', 'node', (ev) => this.selectedId.set(ev.target.id()));
      this._cy.on('tap', (ev) => {
        if (ev.target === this._cy) this.selectedId.set(null);
      });
      this._renderGraph();
    });
    effect(() => {
      this.tasks();
      this.statusFilter();
      this._renderGraph();
    });
    effect(() => {
      // the drawer changes the container width, so Cytoscape must re-measure
      this.selectedId();
      setTimeout(() => this._cy?.resize());
    });
    inject(DestroyRef).onDestroy(() => this._cy?.destroy());
  }

  toggleStatus(status: TaskStatus): void {
    const next = new Set(this.statusFilter());
    if (!next.delete(status)) next.add(status);
    this.statusFilter.set(next);
  }

  switchProject(id: string): void {
    this.selectedId.set(null);
    this._router.navigate(['/project', id, 'graph']);
  }

  private _renderGraph(): void {
    const cy = this._cy;
    if (!cy) return;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(toCytoscapeElements(this.tasks(), this.statusFilter()));
    });
    cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 20, rankSep: 60 } as never).run();
    const id = this.selectedId();
    if (id) cy.getElementById(id).select();
  }
}
