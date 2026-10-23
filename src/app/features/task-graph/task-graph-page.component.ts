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
  untracked,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngrx/store';
import { TranslatePipe } from '@ngx-translate/core';
import cytoscape from 'cytoscape';
import dagre from 'cytoscape-dagre';
import { map } from 'rxjs/operators';
import { GlobalThemeService } from '../../core/theme/global-theme.service';
import { ProjectService } from '../project/project.service';
import { selectAllTasks } from '../tasks/store/task.selectors';
import { Task, TaskStatus } from '../tasks/task.model';
import { T } from '../../t.const';
import { toCytoscapeElements } from './task-graph-elements';
import { TaskGraphDrawerComponent } from './task-graph-drawer.component';
import { buildGraph, getEffectiveStatus } from './task-graph.util';

cytoscape.use(dagre);

const STATUSES: { status: TaskStatus; label: string }[] = [
  { status: 'todo', label: T.F.TASK_GRAPH.STATUS_TODO },
  { status: 'doing', label: T.F.TASK_GRAPH.STATUS_DOING },
  { status: 'pending', label: T.F.TASK_GRAPH.STATUS_PENDING },
  { status: 'done', label: T.F.TASK_GRAPH.STATUS_DONE },
];
const STATUS_LABEL = Object.fromEntries(
  STATUSES.map((s) => [s.status, s.label]),
) as Record<TaskStatus, string>;

/** Reads the app's design tokens so the graph follows the active theme. */
const buildStyle = (el: HTMLElement): cytoscape.StylesheetJson => {
  const css = getComputedStyle(el);
  const v = (name: string, fallback: string): string =>
    css.getPropertyValue(name).trim() || fallback;
  const text = v('--text-color', '#222');
  const muted = v('--text-color-muted', '#777');
  const card = v('--card-bg', '#fff');
  const primary = v('--palette-primary-500', '#1e88e5');
  const warning = v('--color-warning', '#ff9800');

  /* eslint-disable @typescript-eslint/naming-convention */
  // Cytoscape style properties are kebab-case by API
  return [
    {
      selector: 'node',
      style: {
        shape: 'round-rectangle',
        label: 'data(label)',
        'text-wrap': 'wrap',
        'text-max-width': '190px',
        'text-valign': 'center',
        'font-size': 13,
        color: text,
        width: 'label',
        height: 'label',
        padding: '12px',
        'background-color': card,
        'border-width': 1,
        'border-color': muted,
      },
    },
    { selector: 'node.ready', style: { 'border-width': 2, 'border-color': primary } },
    {
      selector: 'node.blocked',
      style: { 'border-style': 'dashed', color: muted },
    },
    {
      selector: 'node.doing',
      style: {
        'border-width': 2,
        'border-color': primary,
        'background-color': primary,
        'background-opacity': 0.22,
      },
    },
    {
      selector: 'node.pending',
      style: {
        'border-width': 2,
        'border-color': warning,
        'background-color': warning,
        'background-opacity': 0.14,
      },
    },
    { selector: 'node.done', style: { color: muted } },
    { selector: 'node.hover', style: { 'border-width': 3 } },
    {
      selector: 'node:selected',
      style: { 'overlay-color': primary, 'overlay-opacity': 0.16, 'overlay-padding': 6 },
    },
    { selector: 'node.dim', style: { opacity: 0.25 } },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': muted,
        'target-arrow-color': muted,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
      },
    },
  ];
  /* eslint-enable @typescript-eslint/naming-convention */
};

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
  readonly STATUS_LABEL = STATUS_LABEL;
  readonly projectService = inject(ProjectService);

  readonly projectId = toSignal(
    this._route.parent!.paramMap.pipe(map((p) => p.get('id') as string)),
    { requireSync: true },
  );
  private _allTasks = toSignal(this._store.select(selectAllTasks), { initialValue: [] });
  readonly tasks = computed<Task[]>(() =>
    this._allTasks().filter((t) => t.projectId === this.projectId()),
  );
  /** Keyboard / screen-reader alternative to the canvas. */
  readonly nodeList = computed(() =>
    buildGraph(this.tasks()).nodes.map((t) => ({
      id: t.id,
      title: t.title,
      status: getEffectiveStatus(t),
    })),
  );
  readonly statusFilter = signal<ReadonlySet<TaskStatus>>(
    new Set(STATUSES.map((s) => s.status)),
  );
  readonly selectedId = signal<string | null>(null);
  readonly selectedTask = computed(
    () => this.tasks().find((t) => t.id === this.selectedId()) ?? null,
  );

  // Only fields that change the picture: the task store also emits on every timer tick,
  // and re-laying out the graph each second would be wasteful.
  private _graphKey = computed(() =>
    JSON.stringify(
      this.tasks().map((t) => [
        t.id,
        t.title,
        t.parentId,
        t.status,
        t.isDone,
        t.dependsOnIds,
        t.smart,
        t.timeEstimate,
        t.deadlineDay,
      ]),
    ),
  );

  // what changes the shape of the graph (not its colours): drives re-fitting the view
  private _structureKey = computed(() =>
    JSON.stringify([
      this.projectId(),
      this.tasks()
        .filter((t) => !t.parentId)
        .map((t) => [t.id, t.dependsOnIds]),
    ]),
  );

  private _container = viewChild.required<ElementRef<HTMLElement>>('container');
  private _cy?: cytoscape.Core;
  private _fittedKey?: string;

  constructor() {
    const isDark = inject(GlobalThemeService).isDarkTheme;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this._container().nativeElement;
      this._cy = cytoscape({
        container: el,
        style: buildStyle(el),
        userZoomingEnabled: true,
        maxZoom: 1.2, // keep a graph with few nodes from being fitted to huge size
        autoungrabify: true, // read-only: nodes cannot be dragged
      });
      this._cy.on('tap', 'node', (ev) => this.selectedId.set(ev.target.id()));
      this._cy.on('tap', (ev) => {
        if (ev.target === this._cy) this.selectedId.set(null);
      });
      this._cy.on('mouseover', 'node', (ev) => {
        ev.target.addClass('hover');
        el.style.cursor = 'pointer';
      });
      this._cy.on('mouseout', 'node', (ev) => {
        ev.target.removeClass('hover');
        el.style.cursor = '';
      });
      // keeps the canvas correct when the drawer opens, the window or the phone rotates
      const observer = new ResizeObserver(() => this._cy?.resize());
      observer.observe(el);
      destroyRef.onDestroy(() => observer.disconnect());
      this._renderGraph();
    });
    effect(() => {
      this._graphKey();
      this.statusFilter();
      this.projectId();
      untracked(() => this._renderGraph());
    });
    effect(() => {
      isDark();
      // wait a tick so the theme class is on the document before tokens are read
      setTimeout(() => {
        if (this._cy) this._cy.style(buildStyle(this._container().nativeElement));
      });
    });
    destroyRef.onDestroy(() => this._cy?.destroy());
  }

  toggleStatus(status: TaskStatus): void {
    const next = new Set(this.statusFilter());
    if (!next.delete(status)) next.add(status);
    this.statusFilter.set(next);
  }

  fit(): void {
    this._cy?.fit(undefined, 24);
  }

  switchProject(id: string): void {
    this.selectedId.set(null);
    this._router.navigate(['/project', id, 'graph']);
  }

  private _renderGraph(): void {
    const cy = this._cy;
    if (!cy) return;
    const elements = toCytoscapeElements(this.tasks(), this.statusFilter());
    cy.batch(() => {
      cy.elements().remove();
      cy.add(elements);
    });
    // re-fit only when nodes or links change; status and field edits keep pan and zoom
    const key = this._structureKey();
    const isFit = elements.length > 0 && this._fittedKey !== key;
    if (isFit) this._fittedKey = key;
    cy.layout({
      name: 'dagre',
      rankDir: 'LR',
      nodeSep: 20,
      rankSep: 60,
      fit: isFit,
    } as never).run();
    const id = this.selectedId();
    if (id) cy.getElementById(id).select();
  }
}
