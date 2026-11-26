import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { MetricsApi } from '../core/api/metrics-api';
import { PruneResult } from '../core/api/models';

/** How long the count of released claims stays up. Failures stay until the next press. */
const DONE_MS = 5000;

/**
 * Releases every outdated claim the pages here booked, in one press.
 *
 * `count` is how many outdated claims the host page lists. The server prunes
 * whatever it finds outdated on every page, so the count names what this page
 * will lose, not everything that goes.
 */
@Component({
  selector: 'mv-prune-outdated',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gen-actions">
      <button class="btn kill" type="button" [disabled]="busy() || !count()" (click)="prune()">
        {{
          busy() ? 'Pruning...' : count() ? 'Prune ' + count() + ' outdated' : 'Nothing outdated'
        }}
      </button>
      @if (done(); as text) {
        <span class="gen-hint" aria-live="polite">{{ text }}</span>
      }
    </div>
    @if (error(); as text) {
      <div class="gen-errors" aria-live="polite">{{ text }}</div>
    }
  `,
})
export class PruneOutdated {
  private readonly api = inject(MetricsApi);

  readonly count = input.required<number>();
  /** Emitted once the server answered, so the host can refresh its listing. */
  readonly pruned = output<PruneResult>();

  protected readonly busy = signal(false);
  protected readonly done = signal('');
  protected readonly error = signal('');

  private doneTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.doneTimer));
  }

  protected prune(): void {
    this.busy.set(true);
    this.done.set('');
    this.error.set('');
    clearTimeout(this.doneTimer);
    this.api.prune().subscribe({
      next: (res) => {
        this.busy.set(false);
        const n = res.removed.length;
        this.done.set(`released ${n} claim${n === 1 ? '' : 's'}`);
        this.doneTimer = setTimeout(() => this.done.set(''), DONE_MS);
        if (res.failed.length) {
          this.error.set('failed: ' + res.failed.map((f) => `${f.name}: ${f.error}`).join('; '));
        }
        this.pruned.emit(res);
      },
      error: (err: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.error.set(err.error?.error ?? 'could not prune outdated claims');
      },
    });
  }
}
