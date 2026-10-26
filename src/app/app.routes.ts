import { Routes } from '@angular/router';

import {
  ActiveWorkContextGuard,
  DefaultStartPageGuard,
  FocusOverlayOpenGuard,
  ValidProjectIdGuard,
  ValidTagIdGuard,
} from './app.guard';
import { LoginGuard } from './core/auth/login.guard';

import { TagTaskPageComponent } from './pages/tag-task-page/tag-task-page.component';

export const APP_ROUTES: Routes = [
  // Eagerly loaded — this is the main view
  {
    path: 'tag/:id/tasks',
    component: TagTaskPageComponent,
    data: { page: 'tag-tasks' },
    canActivate: [LoginGuard, ValidTagIdGuard, FocusOverlayOpenGuard],
  },
  // Tag sub-routes (worklog, history, summary, metrics)
  // Must appear after tag/:id/tasks so the more specific path matches first
  {
    path: 'tag/:id',
    canActivate: [LoginGuard, ValidTagIdGuard],
    canActivateChild: [FocusOverlayOpenGuard],
    loadChildren: () => import('./routes/context.routes').then((m) => m.TAG_CHILD_ROUTES),
  },
  // Project routes (tasks, worklog, history, summary, metrics)
  // Shares one chunk with tag routes via context.routes.ts
  {
    path: 'project/:id',
    canActivate: [LoginGuard, ValidProjectIdGuard],
    canActivateChild: [FocusOverlayOpenGuard],
    loadChildren: () =>
      import('./routes/context.routes').then((m) => m.PROJECT_CHILD_ROUTES),
  },
  // Only route reachable without a session
  {
    path: 'login',
    loadComponent: () =>
      import('./pages/login-page/login-page.component').then((m) => m.LoginPageComponent),
  },
  // Standalone pages — all import from same barrel so they share one chunk
  {
    path: 'config',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.ConfigPageComponent),
    data: { page: 'config' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'search',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.SearchPageComponent),
    data: { page: 'search' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'scheduled-list',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.ScheduledListPageComponent),
    data: { page: 'scheduled-list' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'planner',
    loadComponent: () => import('./routes/pages.routes').then((m) => m.PlannerComponent),
    data: { page: 'planner' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'schedule',
    loadComponent: () => import('./routes/pages.routes').then((m) => m.ScheduleComponent),
    data: { page: 'schedule' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'boards',
    loadComponent: () => import('./routes/pages.routes').then((m) => m.BoardsComponent),
    data: { page: 'boards' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'habits',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.HabitPageComponent),
    data: { page: 'habits' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'donate',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.DonatePageComponent),
    data: { page: 'donate' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'contrast-test',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.ContrastTestComponent),
    data: { page: 'contrast-test' },
    canActivate: [LoginGuard],
  },
  {
    path: 'plugins/:pluginId/index',
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.PluginIndexComponent),
    data: { page: 'plugin-index' },
    canActivate: [LoginGuard, FocusOverlayOpenGuard],
  },
  {
    path: 'active/:subPageType',
    canActivate: [LoginGuard, ActiveWorkContextGuard, FocusOverlayOpenGuard],
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.ConfigPageComponent),
  },
  {
    path: 'active/:subPageType/:param',
    canActivate: [LoginGuard, ActiveWorkContextGuard, FocusOverlayOpenGuard],
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.ConfigPageComponent),
  },
  {
    path: 'active',
    canActivate: [LoginGuard, ActiveWorkContextGuard, FocusOverlayOpenGuard],
    loadComponent: () =>
      import('./routes/pages.routes').then((m) => m.ConfigPageComponent),
  },
  // Wildcard — redirects to default start page
  {
    path: '**',
    canActivate: [LoginGuard, DefaultStartPageGuard],
    component: TagTaskPageComponent,
  },
];
