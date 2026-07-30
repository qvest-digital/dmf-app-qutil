import { ChangeDetectionStrategy, Component, computed, inject, viewChildren } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { hlsPlay, hlsUrl } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { useScene } from '../../core/player/scene';
import { whep } from '../../core/player/whep';
import { FmtPipe } from '../../shared/format-pipes';
import { FlowCard } from './flow-card';
import { GatewayGrid } from './gateway-grid';
import { OperatorFlowList } from './operator-flow-list';
import { PlayerTile } from './player-tile';

/** The four demo flows the writer DaemonSet produces; the grid is fixed at 2x2. */
const TILES = [1, 2, 3, 4] as const;

@Component({
  selector: 'mv-multiviewer-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlayerTile, FlowCard, GatewayGrid, OperatorFlowList, FmtPipe],
  templateUrl: './multiviewer-page.html',
})
export class MultiviewerPage {
  private readonly api = inject(MetricsApi);
  private readonly registry = inject(PlayerRegistry);

  /**
   * Both polls run for as long as this page is mounted, whether or not the tab is
   * visible: they are cheap JSON reads, and the numbers should be current the
   * moment someone looks back. It is the players that must not survive a hidden
   * tab, and useScene handles those.
   */
  private readonly data = poll(1500, () => this.api.flows());
  private readonly operatorFlows = poll(3000, () => this.api.operatorFlows());

  protected readonly flows = computed(() => this.data()?.flows ?? []);
  protected readonly gateways = computed(() => this.data()?.gateways ?? []);
  protected readonly opFlows = computed(() => this.operatorFlows()?.flows ?? []);

  /** Badge state per tile. The grid is fixed, so a missing flow reads as down. */
  protected readonly tileStates = computed(() =>
    TILES.map((n) => {
      const flow = this.flows().find((f) => f.n === n);
      return { n, node: flow?.writer?.node || '--', live: !!flow?.compositor?.live };
    }),
  );

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

  private readonly tileRefs = viewChildren(PlayerTile);

  constructor() {
    useScene(() => this.startPlayers());
  }

  /** WebRTC/WHEP first for sub-second latency, HLS when the handshake fails. */
  private startPlayers(): void {
    for (const tile of this.tileRefs()) {
      const { video, path } = tile;
      whep(this.registry, path, video, {
        onFail: () => hlsPlay(hlsUrl(path), video, { registry: this.registry }),
      });
    }
  }
}
