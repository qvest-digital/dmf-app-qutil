import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterOutlet } from '@angular/router';
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

/** The shell: brand header, clock, and the routed page. */
@Component({
  selector: 'mv-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, QvestLogo],
  templateUrl: './app.html',
})
export class App {
  protected readonly clock = signal(wallClock());

  constructor() {
    const tick = setInterval(() => this.clock.set(wallClock()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }
}
