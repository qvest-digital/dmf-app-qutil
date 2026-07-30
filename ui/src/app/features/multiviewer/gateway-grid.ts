import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { Gateway } from '../../core/api/models';

/** Per-node mxl-k8s gateway pods — the DaemonSet that materializes the mirrors. */
@Component({
  selector: 'mv-gateway-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gwgrid">
      @for (gw of gateways(); track gw.name) {
        <div class="gw">
          <div class="node">{{ gw.node }}</div>
          ready {{ gw.ready ? '✓' : '✗' }} · restarts {{ gw.restarts }}<br />
          <span class="name">{{ gw.name }}</span>
        </div>
      } @empty {
        <div class="gw">no gateway pods</div>
      }
    </div>
  `,
})
export class GatewayGrid {
  readonly gateways = input<Gateway[]>([]);
}
