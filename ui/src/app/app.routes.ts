import { Routes } from '@angular/router';

/**
 * The multiviewer is the whole app: one route, and anything else resolves to it.
 *
 * Deep links need Caddy's `try_files {path} /index.html`; without it a reload
 * on a route path hits the file_server and 404s.
 */
export const routes: Routes = [
  {
    path: '',
    title: 'Multiviewer - MXL RDMA',
    loadComponent: () =>
      import('./features/multiviewer/multiviewer-page').then((m) => m.MultiviewerPage),
  },
  { path: '**', redirectTo: '' },
];
