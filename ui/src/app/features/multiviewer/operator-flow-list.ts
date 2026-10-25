import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OperatorFlow, RedundancySet } from '../../core/api/models';
import { FlowGroupHead } from './flow-group-head';
import { OperatorFlowRow } from './operator-flow-row';
import { SetBundleBox } from './set-bundle-box';
import { inventoryRows, ListRow } from './set-bundles';

/**
 * The operator's flow inventory: every MxlFlow CR the mxl-k8s operator knows
 * about, independent of whether this demo happens to produce or play it, and
 * the redundancy sets over them.
 */
@Component({
  selector: 'mv-operator-flow-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlowGroupHead, OperatorFlowRow, SetBundleBox],
  template: `
    <div class="gwbar">
      <h2>
        Operator flows <span class="of-count">{{ count() }}</span>
      </h2>
      <div class="flows">
        @for (item of rows(); track key(item)) {
          @if (item.kind === 'sets') {
            <mv-set-bundle-box [bundle]="item.bundle" />
          } @else {
            <div class="flow-group">
              @if (item.row.group) {
                <mv-flow-group-head [group]="item.row.group" />
              }
              @for (flow of item.row.flows; track flow.id) {
                <mv-operator-flow-row [flow]="flow" />
              }
            </div>
          }
        } @empty {
          <div class="flow empty">No flows registered with the operator.</div>
        }
      </div>
    </div>
  `,
})
export class OperatorFlowList {
  readonly flows = input<OperatorFlow[]>([]);
  readonly sets = input<RedundancySet[]>([]);

  protected readonly count = computed(() => {
    const flows = this.flows().length;
    const sets = this.sets().length;
    if (!sets) return flows ? `(${flows})` : '';
    return `(${flows}, ${sets} redundancy ${sets === 1 ? 'set' : 'sets'})`;
  });

  /**
   * The flows of one NMOS group render as one box under the group's name, so
   * they have to be adjacent. An ungrouped flow is a box of one, with no head.
   * A redundancy set takes its members and its output into a box of its own,
   * with the sets its members share a group with.
   */
  protected readonly rows = computed(() => inventoryRows(this.flows(), this.sets()));

  /** A box keeps its identity across polls by what anchors it. */
  protected key(item: ListRow): string {
    return item.kind === 'sets'
      ? `set:${item.bundle.sets[0].set.name}`
      : `flow:${item.row.flows[0].id}`;
  }
}
