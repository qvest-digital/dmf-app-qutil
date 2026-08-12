import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { FmtPipe } from '../../shared/format-pipes';
import { FlowPreview } from '../preview/flow-preview';
import { PreviewController } from '../preview/preview-controller';
import { GatewayGrid } from './gateway-grid';
import { OperatorFlowList } from './operator-flow-list';

@Component({
  selector: 'mv-multiviewer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GatewayGrid, OperatorFlowList, FlowPreview, FmtPipe],
  templateUrl: './multiviewer-page.html',
})
export class MultiviewerPage {
  private readonly api = inject(MetricsApi);

  /**
   * What the preview column carries. Held by the controller rather than by this
   * page so the Preview button in a polled flow row can add to it.
   */
  protected readonly previews = inject(PreviewController).requests;

  /**
   * Both polls run for as long as this page is mounted, whether or not the tab is
   * visible: they are cheap JSON reads, and the numbers should be current the
   * moment someone looks back.
   */
  private readonly data = poll(1500, () => this.api.flows());
  private readonly operatorFlows = poll(3000, () => this.api.operatorFlows());

  private readonly flows = computed(() => this.data()?.flows ?? []);

  protected readonly gateways = computed(() => this.data()?.gateways ?? []);
  protected readonly opFlows = computed(() => this.operatorFlows()?.flows ?? []);

  /**
   * Null until a poll actually lands. A zero here would claim the fabric is
   * carrying nothing, when what is true is that we have not been told yet.
   */
  protected readonly totals = computed(() => {
    if (!this.data()) return null;
    const flows = this.flows();
    return {
      mbps: flows.reduce((sum, f) => sum + (f.compositor?.mbps ?? 0), 0),
      fps: flows.reduce((sum, f) => sum + (f.compositor?.fps ?? 0), 0),
      live: flows.filter((f) => f.compositor?.live).length,
      total: flows.length,
    };
  });
}
