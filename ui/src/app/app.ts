import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { MetricsApi } from './core/api/metrics-api';
import { QutilLogo } from './shared/qutil-logo';
import { QvestLogo } from './shared/qvest-logo';

/** Quarter-second ticks, so the clock reads as live rather than as a stamp. */
const CLOCK_MS = 250;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function wallClock(): string {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The shell: brand header, clock, tab bar, and the routed page. */
@Component({
  selector: 'mv-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, QvestLogo, QutilLogo],
  templateUrl: './app.html',
})
export class App {
  protected readonly clock = signal(wallClock());

  /** The Noisy neighbour tab only where the install turned the page on: it
   *  books load onto nodes others measure on, and most installs leave it off.
   *  Asked once; the route itself still says so when reached directly. */
  protected readonly noisy = toSignal(
    inject(MetricsApi)
      .noisy()
      .pipe(
        map((res) => res.enabled === true),
        catchError(() => of(false)),
      ),
    { initialValue: false },
  );

  constructor() {
    const tick = setInterval(() => this.clock.set(wallClock()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }
}
