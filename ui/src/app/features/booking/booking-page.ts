import { ChangeDetectionStrategy, Component, computed, inject, viewChildren } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { useScene } from '../../core/player/scene';
import { BookingTile } from './booking-tile';
import { EventLog } from './event-log';
import { PhaseBand } from './phase-band';
import { SignalChain } from './signal-chain';
import { StateBlock } from './state-block';

/** The two instances a booking can deploy, and how the tiles are labelled. */
const TILES = [
  { name: 't1', title: 'Template 1 · Instance t1' },
  { name: 't2', title: 'Template 2 · Instance t2' },
] as const;

/**
 * The MediaOps booking showcase, sized to fit one screen: two instances on the
 * left, the schedule's effect on the cluster on the right.
 */
@Component({
  selector: 'mv-booking-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BookingTile, PhaseBand, SignalChain, StateBlock, EventLog],
  templateUrl: './booking-page.html',
})
export class BookingPage {
  private readonly api = inject(MetricsApi);

  /**
   * Unlike the multiviewer's polls this one is scene-scoped by virtue of living on
   * this page: leaving the route stops it along with the players.
   */
  private readonly data = poll(2500, () => this.api.booking());

  protected readonly tiles = TILES;

  /** An error payload carries no instances, so keep showing the last good one. */
  protected readonly instances = computed(() => this.data()?.instances ?? []);
  protected readonly story = computed(() => this.data()?.story ?? []);

  private readonly tileRefs = viewChildren(BookingTile);

  /** Either tile showing motion is enough for the chain's downstream nodes. */
  protected readonly frames = computed(() => this.tileRefs().some((t) => t.live()));

  constructor() {
    useScene(() => {
      for (const tile of this.tileRefs()) tile.start();
    });
  }

  protected instanceFor(name: string) {
    return this.instances().find((i) => i.name === name);
  }
}
