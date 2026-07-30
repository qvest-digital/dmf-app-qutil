import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { FlowPreviewModal } from './features/preview/flow-preview-modal';
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

/**
 * The shell: brand header, the tab bar, and the preview overlay.
 *
 * The overlay lives here rather than on the multiviewer page so a preview keeps
 * playing when the audience switches tabs, as it did on the page this replaces.
 */
@Component({
  selector: 'mv-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, QvestLogo, FlowPreviewModal],
  templateUrl: './app.html',
})
export class App {
  protected readonly clock = signal(wallClock());

  constructor() {
    const tick = setInterval(() => this.clock.set(wallClock()), CLOCK_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));
  }
}
