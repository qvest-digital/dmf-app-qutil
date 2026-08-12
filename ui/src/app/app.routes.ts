import { Routes } from '@angular/router';

/**
 * One route per tab.
 *
 * Leaving a route destroys its page component, which tears down whatever that
 * page was polling or playing, so nothing keeps running once it is off screen.
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
  {
    path: 'gen',
    title: 'Generators - MXL RDMA',
    loadComponent: () =>
      import('./features/generators/generators-page').then((m) => m.GeneratorsPage),
  },
  { path: '**', redirectTo: '' },
];
