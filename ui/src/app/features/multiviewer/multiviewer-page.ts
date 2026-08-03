import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  computed,
  effect,
  inject,
  untracked,
  viewChildren,
} from '@angular/core';
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

/** The four demo flows the writer claims produce; the grid is fixed at 2x2. */
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
  private readonly doc = inject(DOCUMENT);

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
      return {
        n,
        node: flow?.writer?.node || '--',
        live: !!flow?.compositor?.live,
        uuid: flow?.uuid ?? '',
      };
    }),
  );

  /**
   * The flow ids in tile order, as one string, so the effect below runs when a
   * flow actually appears rather than on every 1.5s poll.
   */
  private readonly tileFlows = computed(() =>
    this.tileStates()
      .map((t) => t.uuid)
      .join(','),
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

  /** Tiles with a path already asked for, so a rerun does not ask twice. */
  private readonly opened = new Set<number>();

  constructor() {
    useScene(() => this.startPlayers());
    // A tile's path is created from its flow id, and that id arrives with the
    // first metrics poll -- after useScene has already run. Running again when
    // the ids land is what attaches the players.
    //
    // untracked keeps the dependency to the ids alone. Without it the poll's
    // own signal reads inside startPlayers would make this run every 1.5s.
    effect(() => {
      this.tileFlows();
      untracked(() => this.startPlayers());
    });
  }

  private startPlayers(): void {
    // The scene rebuilds players on becoming visible; starting one for a hidden
    // tab would hold a reader open for a decoder that is about to be torn down.
    if (this.doc.visibilityState === 'hidden') return;
    for (const tile of this.tileRefs()) {
      const n = tile.n();
      const uuid = this.tileStates().find((t) => t.n === n)?.uuid;
      if (!uuid || this.opened.has(n)) continue;
      this.opened.add(n);
      this.openTile(n, uuid, tile.video);
    }
  }

  /**
   * Ask the aggregator for a path carrying this flow, then play it: WebRTC/WHEP
   * first for sub-second latency, HLS when the handshake fails.
   *
   * The path is per-flow and shared -- the operator overlay derives the same one
   * for the same flow -- so the aggregator counts holders and this tile names
   * itself as one.
   */
  private openTile(n: number, uuid: string, video: HTMLVideoElement): void {
    const owner = `tile-${n}`;
    this.api.startPreview(uuid, owner).subscribe({
      next: ({ path }) => {
        whep(this.registry, path, video, {
          onFail: () => hlsPlay(hlsUrl(path), video, { registry: this.registry }),
        });
        // Tracked after the players so a teardown stops them before the path
        // goes, and so releasing it is owned by the same mechanism that owns
        // player lifetime rather than by a second hook that could disagree.
        this.registry.track({
          kind: 'preview',
          stop: () => {
            this.opened.delete(n);
            this.api.stopPreview(uuid, owner).subscribe({ error: () => {} });
          },
        });
      },
      // Nothing playing and nothing held: let the next flow change try again.
      error: () => this.opened.delete(n),
    });
  }
}
