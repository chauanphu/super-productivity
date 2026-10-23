# Dependency Graph View + SMART Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-project read-only dependency graph (Cytoscape) with a side drawer to edit status, prerequisites, SMART fields and the planned day.

**Architecture:** New optional fields on `Task` (`status`, `pendingNote`, `dependsOnIds`, `smart`) written through the existing `TaskService.update` (so persistence/op-log come for free). Pure functions in one util file build the graph and enforce rules. One lazy-loaded standalone component renders Cytoscape and hosts the drawer. Planning for a day reuses `PlannerActions.planTaskForDay`.

**Tech Stack:** Angular 21 standalone + signals, NgRx, Cytoscape.js + `cytoscape-dagre`, Jasmine/Karma.

**Spec:** `docs/superpowers/specs/2026-10-23-dag-smart-planning-design.md`

## Global Constraints

- Subtasks are never graph nodes; archived tasks are not drawn; done tasks are drawn.
- `dependsOnIds` only within one project; no cycles.
- Status values exactly: `'todo' | 'doing' | 'done' | 'pending'`; UI labels Chưa bắt đầu / Đang làm / Đã xong / Pending.
- SMART letters filled: S has text; M has `metric.target > 0`; A has `timeEstimate > 0` and `confidence`; R has text; T has `deadlineDay`.
- UI strings via `T` keys, edit `en.json` only. Never log task titles. Run `npm run checkFile <file>` per modified ts/scss file.
- Layout is read-only: no drag-and-drop editing.

## Review Focus

- A task whose `dependsOnIds` points to a deleted/other-project/subtask id → ignored, no crash.
- Cycle already present in data → graph renders, offending edge ignored.
- Project with zero tasks → empty state, no Cytoscape error.
- Task marked done in the normal UI while `status` is `'doing'` → shown as done.
- Picking a day earlier than a prerequisite's `dueDay` → warning shown, action still allowed.

## Deviation from spec (shortcut)

Spec says delete/move-to-project clears `dependsOnIds` through meta-reducers. This plan instead ignores dangling or cross-project ids when reading (`buildGraph`). Same visible result, no change to sync-critical reducers; stale ids stay in data. Upgrade to meta-reducer cleanup if stale ids cause trouble.

---

### Task 1: Model fields and pure graph logic

**Files:**

- Modify: `src/app/features/tasks/task.model.ts` (TaskCopy)
- Create: `src/app/features/task-graph/task-graph.util.ts`
- Test: `src/app/features/task-graph/task-graph.util.spec.ts`

**Interfaces:**

- Produces (in `task.model.ts`): `type TaskStatus = 'todo'|'doing'|'done'|'pending'`; `interface TaskSmart { specific?: string; metric?: { unit?: string; target: number; current: number }; confidence?: number; relevance?: string }`; `TaskCopy` gains optional `status?: TaskStatus; pendingNote?: string; dependsOnIds?: string[]; smart?: TaskSmart`.
- Produces (in util): `getEffectiveStatus(t: Task): TaskStatus`; `smartScore(t: Task): number`; `buildGraph(tasks: Task[]): { nodes: Task[]; edges: { source: string; target: string }[] }` (edge `source` = prerequisite, `target` = dependent); `isBlocked(t: Task, byId: Map<string, Task>): boolean`; `wouldCreateCycle(tasks: Task[], taskId: string, prerequisiteId: string): boolean`; `latestPrerequisiteDay(t: Task, byId: Map<string, Task>): string | null`.

- [ ] **Step 1: Write failing tests** in the spec file: `getEffectiveStatus` returns `'done'` when `isDone` even if `status==='doing'`, `'todo'` when status undefined; `smartScore` is 5 only when all five rules hold and 0 for a bare task; `buildGraph` drops subtasks (`parentId`), dangling ids, other-project ids (nodes are the passed tasks only) and a cycle edge, keeping a valid DAG's edges; `isBlocked` true for a not-done prerequisite, false when all done; `wouldCreateCycle(tasks,'a','b')` true when b already depends on a (directly or transitively) and for self; `latestPrerequisiteDay` returns the max `dueDay` of prerequisites, null when none.
- [ ] **Step 2: Run** `npm run test:file src/app/features/task-graph/task-graph.util.spec.ts` — expect FAIL (module missing).
- [ ] **Step 3: Add the model fields** exactly as in Interfaces, then implement the util. `buildGraph` keeps edges whose both ends are in `nodes`, then drops edges that close a cycle (DFS/Kahn; keep first-seen edges).
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(tasks): add status, dependsOnIds and SMART fields with graph rules`.

### Task 2: Graph view (Cytoscape) and route

**Files:**

- Modify: `package.json` (`cytoscape`, `cytoscape-dagre`), `src/app/routes/context.routes.ts` (child route `graph`, lazy `loadComponent`)
- Create: `src/app/features/task-graph/task-graph-page.component.ts` (+ `.html`, `.scss`)
- Modify: `src/assets/i18n/en.json` (keys under `F.TASK_GRAPH`)
- Test: `src/app/features/task-graph/task-graph-page.component.spec.ts`

**Interfaces:**

- Consumes: Task 1 util; `WorkContextService` (active project's `undoneTasks$`/`doneTasks$` or the NgRx selector for project tasks).
- Produces: component `TaskGraphPageComponent` with signals `tasks`, `statusFilter` (`Set<TaskStatus>`), `selectedId` (`string | null`); pure helper `toCytoscapeElements(tasks: Task[], filter: Set<TaskStatus>)` (exported from the component file) returning Cytoscape element definitions with node classes `todo|doing|done|pending|blocked|ready|dim`.

- [ ] **Step 1: Failing test** for `toCytoscapeElements`: node count equals `buildGraph(...).nodes.length`; a `todo` task with unfinished prerequisite has class `blocked`; with all prerequisites done has `ready`; a node whose status is not in the filter has class `dim`; node label contains `SMART 3/5` for a task scoring 3.
- [ ] **Step 2:** Run it — expect FAIL.
- [ ] **Step 3:** `npm i cytoscape cytoscape-dagre` (check peer/Angular build works with `npx ng build` later). Implement the helper and the component: filter chips, project name header, empty state, Cytoscape mounted in `viewChild` container with dagre `rankDir: 'LR'`, node click sets `selectedId`. Style by class: todo grey-blue, doing orange, done green, pending purple, blocked dashed border, ready thick blue border. Destroy the instance on destroy.
- [ ] **Step 4:** Run the spec — expect PASS. Add route `graph` to `PROJECT_CHILD_ROUTES`.
- [ ] **Step 5: Commit** `feat(task-graph): add project dependency graph view`.

### Task 3: Edit drawer

**Files:**

- Create: `src/app/features/task-graph/task-graph-drawer.component.ts` (+ `.html`)
- Modify: `task-graph-page.component.*` (host the drawer), `en.json`
- Test: `src/app/features/task-graph/task-graph-drawer.component.spec.ts`

**Interfaces:**

- Consumes: `TaskService.update(id, Partial<Task>)`, `PlannerActions.planTaskForDay({ task, day })`, Task 1 util.
- Produces: component inputs `task: Task`, `projectTasks: Task[]`; output `closed`. Pure exported helper `buildPatch(task, form): Partial<Task>` where setting status `'done'` also sets `isDone: true` and any other status sets `isDone: false`, and `pendingNote` is cleared unless status is `'pending'`.

- [ ] **Step 1: Failing tests** for `buildPatch` (done → `isDone:true`; doing → `isDone:false`; non-pending clears note) and for the drawer prerequisite options: excludes the task itself, subtasks, and any task for which `wouldCreateCycle` is true; plan-day warning text is shown when the chosen day is earlier than `latestPrerequisiteDay`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement drawer: status select, pending note (only when pending), prerequisite multi-select, SMART fields (S text, M unit/target/current, A estimate+confidence 1-5, R text, T `deadlineDay`), plan-day date input dispatching `planTaskForDay` and showing the advisory warning. Each field change calls `taskService.update`.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** `feat(task-graph): add edit drawer with status, prerequisites and SMART`.

### Task 4: Navigation and verification

**Files:**

- Modify: the project nav where `worklog`/`tasks` links are defined (find via `grep -rn "quick-history" src/app --include=*.html --include=*.ts`), `en.json`

- [ ] **Step 1:** Add a "Graph" link to `project/:id/graph` next to the project's existing links.
- [ ] **Step 2:** Run `npm run lint` and `npx ng build` — expect no errors; run all new specs together.
- [ ] **Step 3:** Run the app, open a project, add 3 tasks with dependencies via the drawer, confirm colours, filter, planning warning.
- [ ] **Step 4: Commit** `feat(task-graph): link graph view from project navigation`.
