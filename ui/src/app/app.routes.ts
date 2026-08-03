import { Routes } from '@angular/router';

/**
 * One route per tab.
 *
 * Leaving a route destroys its page component, which tears down that page's
 * players, so nothing keeps decoding once it is off screen.
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
    path: 'srt',
    title: 'SRT Camera - MXL RDMA',
    loadComponent: () => import('./features/srt/srt-page').then((m) => m.SrtPage),
  },
  // A former path for the same page, kept so links written against it resolve.
  { path: 'tx', redirectTo: 'srt' },
  {
    path: 'cp',
    title: 'Composite - MXL RDMA',
    loadComponent: () => import('./features/composite/composite-page').then((m) => m.CompositePage),
  },
  {
    path: 'bk',
    title: 'Booking - MXL RDMA',
    loadComponent: () => import('./features/booking/booking-page').then((m) => m.BookingPage),
  },
  { path: '**', redirectTo: '' },
];
