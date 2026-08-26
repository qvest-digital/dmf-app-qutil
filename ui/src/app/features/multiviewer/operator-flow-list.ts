import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { OperatorFlow } from '../../core/api/models';
import { audioSiblingOf } from '../preview/flow-groups';
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
          <mv-operator-flow-row [flow]="flow" [audioSibling]="siblingOf(flow)" />
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
   * Computed once per render rather than per row: grouping walks the whole
   * inventory, and a row cannot see its own siblings.
   */
  private readonly siblings = computed(() => {
    const byVideo = new Map<string, OperatorFlow>();
    for (const flow of this.flows()) {
      const audio = audioSiblingOf(flow, this.flows());
      if (audio) byVideo.set(flow.id, audio);
    }
    return byVideo;
  });

  protected siblingOf(flow: OperatorFlow): OperatorFlow | null {
    return this.siblings().get(flow.id) ?? null;
  }
}
