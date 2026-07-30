import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BookingInstance } from '../../core/api/models';

/** What each deployed instance currently is, in key-value form. */
@Component({
  selector: 'mv-state-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="bk-state">
      @if (instances().length) {
        @for (inst of instances(); track inst.name; let first = $first) {
          @if (!first) {
            <hr />
          }
          <div class="kvline">
            <div>Instance</div>
            <div>
              <b>{{ inst.name }}</b> ({{ inst.type || '?' }})
            </div>
            <div>Phase</div>
            <div>{{ inst.phase || '—' }}</div>
            <div>Pod</div>
            <div>{{ podState(inst) }}</div>
            <div>Sources</div>
            <div>{{ (inst.sources || []).length }}</div>
          </div>
        }
      } @else {
        no instance deployed — waiting for pre-roll
      }
    </div>
  `,
})
export class StateBlock {
  readonly instances = input<BookingInstance[]>([]);

  /** A pod with a deletionTimestamp is on its way out, whatever its phase says. */
  protected podState(inst: BookingInstance): string {
    if (!inst.pod) return '—';
    return inst.pod.deleting ? 'terminating' : (inst.pod.phase ?? '—');
  }
}
