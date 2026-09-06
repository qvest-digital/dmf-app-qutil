import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';
import { groupedFlowRows } from '../preview/flow-groups';
import { FlowGroupHead } from './flow-group-head';
import { OperatorFlowRow } from './operator-flow-row';

/**
 * The operator's flow inventory: every MxlFlow CR the mxl-k8s operator knows
 * about, independent of whether this demo happens to produce or play it.
 */
@Component({
  selector: 'mv-operator-flow-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlowGroupHead, OperatorFlowRow],
  template: `
    <div class="gwbar">
      <h2>
        Operator flows <span class="of-count">{{ count() }}</span>
      </h2>
      <div class="flows">
        @for (row of rows(); track row.flows[0].id) {
          <div class="flow-group">
            @if (row.group) {
              <mv-flow-group-head [group]="row.group" />
            }
            @for (flow of row.flows; track flow.id) {
              <mv-operator-flow-row [flow]="flow" />
            }
          </div>
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

  /**
   * The flows of one NMOS group render as one box under the group's name, so
   * they have to be adjacent. An ungrouped flow is a box of one, with no head.
   */
  protected readonly rows = computed(() => groupedFlowRows(this.flows()));
}
