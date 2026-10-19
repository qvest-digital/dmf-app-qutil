import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { GeneratorReader } from '../../core/api/models';
import { readerState } from './generator-state';

/**
 * One reader on one line: where it reads, over what, and whether its flows
 * arrive. The same line under a generator, among the readers of chosen flows,
 * and among the orphans, so all three read alike.
 */
@Component({
  selector: 'mv-reader-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gen-reader">
      <span class="dot" [class]="state().cls" [title]="tooltip()"></span>
      <span class="gen-reader-name">{{ reader().name }}</span>
      <span class="gen-reader-meta">
        {{ reader().node ? 'on ' + reader().node : 'any node' }} |
        {{ reader().provider ?? 'auto' }} | {{ state().label }}
        @if (showFlows()) {
          | {{ flows() }}
        }
      </span>
      <button
        class="btn kill"
        type="button"
        [disabled]="busy() || reader().deleting"
        (click)="remove.emit(reader().name)"
      >
        {{ busy() ? 'Deleting...' : 'Delete' }}
      </button>
    </div>
  `,
})
export class ReaderRow {
  readonly reader = input.required<GeneratorReader>();
  /** A delete is in flight for this reader. */
  readonly busy = input(false);
  /** Name the flows read: under a generator they are the generator's own. */
  readonly showFlows = input(false);
  readonly remove = output<string>();

  protected readonly state = computed(() => readerState(this.reader()));

  protected readonly flows = computed(() => (this.reader().flows ?? []).join(', ') || '--');

  protected readonly tooltip = computed(() => {
    const reader = this.reader();
    const phase = reader.phase ?? 'no phase yet';
    return [
      reader.reachable?.message ? `${phase}: ${reader.reachable.message}` : phase,
      (reader.flows ?? []).join(', '),
    ]
      .filter(Boolean)
      .join(' | ');
  });
}
