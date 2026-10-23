# Dependency graph view + SMART fields for tasks

Date: 2026-10-23. Status: draft, awaiting approval. Items marked **(my call)** were decided by the author of this document, not by the user.

## Intent

The user manages long-running projects as a DAG of tasks (which task depends on which). Today they draw that DAG in draw.io, because todo-style tools do not show, in one picture, which tasks are in progress, which are blocked by others, and which can run in parallel. They think more easily in graphs than in Gantt charts or tables.

Goal: plan inside Super Productivity instead of draw.io. See a whole project as a graph, add SMART detail per task, and turn tasks into per-day work.

## Users and context

One user, one machine (no multi-device sync needed, so no cross-device conflict design). Several projects run in parallel; switching between projects is a first-class action. Existing guidance in `customization.md` (time-blocking, 1-3 priorities per day, weekly minimums) is background, not a requirement for this work.

## Goals

1. **Graph view per project.** One view shows all top-level tasks of a project as a DAG, auto-laid-out left to right, read-only (no drag-and-drop editing of the layout or edges).
2. **Status at a glance.** Node colour shows the status: *todo*, *doing*, *pending*, *done*, plus the blocked-by-prerequisite cue on todo nodes. Nodes that can run in parallel sit in the same layout column (a natural result of layered layout).
3. **Filter by status.** The user can filter doing / todo / pending (and done). Non-matching nodes are dimmed, not removed, so the structure stays readable.
4. **Switch project.** A project picker switches the graph to another project. Dependencies replace subtasks for planning; the graph shows top-level tasks only and ignores subtasks (my call).
5. **Edit through a side drawer.** Clicking a node opens a drawer to edit status, prerequisites and SMART fields.
6. **SMART per task** (see Data).
7. **Day planning.** From the drawer, plan the task for a day (day-level only, no time of day). Reuse the existing Planner (`PlannerActions.planTaskForDay`, `dueDay`). Warn when the chosen day is earlier than a prerequisite's planned day (my call).

## Non-goals

- Drag-and-drop graph editing, drawing edges by mouse.
- Time-of-day scheduling on the new view (`dueWithTime`); Gantt chart; new calendar UI.
- Multi-device sync design, SuperSync/Dropbox conflict handling for the new fields beyond what existing task persistence gives for free.
- Critical-path calculation, backward scheduling from deadlines (possible later; not in v1) (my call).

## Anti-goals

- Must not break existing subtasks, Planner, or task persistence.
- Must not create cycles: a task cannot (transitively) depend on itself.
- No re-implementing layout or rendering from scratch (the user explicitly wants a library).

## Decided by the user

- Use **Cytoscape.js** for rendering, with a layered layout plugin (`cytoscape-dagre`, or `cytoscape-elk` if dagre proves limiting). Not verified against the project's Angular version (21.x); the builder must check this before installing.
- Whole project in one view; filter by group; project switching; calendar scheduling is day-level only.
- Editing happens in a drawer, not on the canvas.

## Data (builder to confirm exact shape)

Reuse existing task fields wherever they exist (my call):

| SMART letter | Source |
|---|---|
| Specific | new `smart.specific` (text, definition of done) |
| Measurable | new `smart.metric`: `{ unit?: string, target: number, current: number }` |
| Achievable | existing `timeEstimate` plus new `smart.confidence` (1-5) |
| Relevant | new `smart.relevance` (free text: the goal or milestone this serves) |
| Time-bound | existing `deadlineDay` |

New on the task: `dependsOnIds?: string[]` (prerequisite task ids). A SMART completeness score (0-5, number of letters filled) is derived, not stored, and shown on the node label as "SMART n/5".

Status is an explicit, user-set field (decided by the user): `status: 'todo' | 'doing' | 'done' | 'pending'` (shown as Chưa bắt đầu, Đang làm, Đã xong, Pending).
- **pending** means work was in progress but a problem was found and it cannot continue. It carries a free-text note `pendingNote` with the condition for resuming. Cancelling a pending task completely is done by the existing delete (my call).
- `status: 'done'` and the existing `isDone` must stay consistent; the builder decides how (my call: `isDone` stays the source for existing features, and the status change also sets it).
- The graph also shows a **blocked-by-prerequisite** cue (derived, not a status): a `todo` task with at least one unfinished prerequisite is drawn greyed/dashed, so "ready to start" tasks (todo with all prerequisites done) stand out (my call).

All changes go through NgRx actions and persistence in the same way as existing task fields; they must be validated by the existing Typia model validation. Follow CLAUDE.md rules for effects (`LOCAL_ACTIONS`), atomic multi-entity changes (meta-reducers, e.g. deleting a task removes it from other tasks' `dependsOnIds`), and no user content in logs.

## Placement in the app

New route under a project, for example `project/:id/graph`, next to existing project views; a project picker in the view header. The drawer is an Angular Material side sheet.

## Further calls by the author (from the builder check) — all **(my call)**

- **Graph contents:** all top-level, non-archived tasks of the project, done ones included (shown green) so the structure stays readable. Subtasks are never nodes. The prerequisite picker lists top-level tasks of the same project only. Inbox is a project like any other.
- **Same-project only:** `dependsOnIds` never crosses projects. Moving a task to another project clears its `dependsOnIds` and removes it from other tasks' `dependsOnIds` (one meta-reducer pass). Deleting a task does the same. Archiving or completing keeps the links. Duplicating copies `smart` but not `dependsOnIds`.
- **Cycles:** the picker hides tasks that would create a cycle and the reducer rejects such a change. If a cycle exists in loaded data anyway, the graph ignores the offending edge instead of failing.
- **Planner warning:** advisory only (never blocks). Compares the chosen `dueDay` with prerequisites' `dueDay`; prerequisites without a planned day are ignored. "Plan for day" in the drawer is exactly `planTaskForDay`.
- **Drawer details:** `deadlineDay` (already in the task model) is editable in the drawer. `smart.metric.current` is entered by hand and never marks the task done. A SMART letter counts as filled when: S has text; M has `target > 0`; A has `timeEstimate > 0` and `confidence`; R has text; T has `deadlineDay`.
- **Loading and state:** the graph route is lazy-loaded (Cytoscape is large). The selected project is the route parameter; no extra persisted state.
- **Library fallback:** if Cytoscape fails on Angular 21, switch to another maintained graph library with layered layout; the "no from-scratch rendering" rule stays.

## Left to the builder

Layout plugin choice and tuning, exact route/nav placement, drawer UX details, styling per `docs/styling-guide.md`, translation keys (`en.json` only), test plan, how `status` stays in sync with `isDone` and with the existing current-task/timer behaviour.

## Open items the builder must verify

- Cytoscape and the chosen layout plugin work with Angular 21 and the project's build setup.
- Whether Planner already shows tasks from all projects together (the user wants to schedule within or across projects on one calendar). If not, the smallest change that gets there.
