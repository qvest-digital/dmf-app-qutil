import { Routes } from '@angular/router';

/**
 * One route per tab. The paths match the original page's tab ids (mv/tx/cp/bk) so
 * a link someone wrote down still lands where they expect.
 *
 * Leaving a route destroys its page component, which tears down that page's
 * players — the router does the job `MV.teardownAll()` used to do by hand.
 *
 * Deep links need Caddy's `try_files {path} /index.html`; without it a reload on
 * /tx hits the file_server and 404s.
 */
export const routes: Routes = [
  {
    path: '',
    title: 'Multiviewer · MXL RDMA',
    loadComponent: () =>
      import('./features/multiviewer/multiviewer-page').then((m) => m.MultiviewerPage),
  },
  {
    path: 'tx',
    title: 'txDarwin / SRT · MXL RDMA',
    loadComponent: () => import('./features/tx/tx-page').then((m) => m.TxPage),
  },
  {
    path: 'cp',
    title: 'Composite · MXL RDMA',
    loadComponent: () => import('./features/composite/composite-page').then((m) => m.CompositePage),
  },
  {
    path: 'bk',
    title: 'Booking · MXL RDMA',
    loadComponent: () => import('./features/booking/booking-page').then((m) => m.BookingPage),
  },
  { path: '**', redirectTo: '' },
];
