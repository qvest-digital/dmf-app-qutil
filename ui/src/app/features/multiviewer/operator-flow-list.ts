import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';
import { OperatorFlowRow } from './operator-flow-row';

/**
 * The operator's flow inventory: every MxlFlow CR the mxl-k8s operator knows
 * about, independent of whether this demo happens to produce or play it.
 */
@Component({
  selector: 'mv-operator-flow-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [OperatorFlowRow],
  template: `
    <div class="gwbar">
      <h2>
        Operator flows <span class="of-count">{{ count() }}</span>
      </h2>
      <div class="flows">
        @for (flow of flows(); track flow.id) {
          <mv-operator-flow-row [flow]="flow" />
        } @empty {
          <div class="flow empty">No flows registered with the operator.</div>
        }
      </div>
    </div>
  `,
})
export class OperatorFlowList {
  readonly flows = input<OperatorFlow[]>([]);

  protected readonly count = computed(() =>
    this.flows().length ? `(${this.flows().length})` : '',
  );
}
