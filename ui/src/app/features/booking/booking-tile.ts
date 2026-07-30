import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { BookingInstance } from '../../core/api/models';
import { HlsHandle, hlsPlay, hlsUrl } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { WhepHandle, whep } from '../../core/player/whep';
import { VideoShell } from '../../shared/video-shell';

/** Liveness is sampled, and reconnects are paced, on the same beat. */
const TICK_MS = 4000;
const BACKOFF_START_MS = 4000;
const BACKOFF_MAX_MS = 60000;
/** currentTime has to move by more than float noise to count as playing. */
const PROGRESS_EPSILON = 0.01;

/**
 * One of the two instances a MediaOps booking can deploy.
 *
 * Its chips are what the template wired — two is template-1, three is template-2 —
 * and the highlighted chip is the source the reader is on *right now*, read from
 * txDarwin itself, so switching in its UI shows up here.
 *
 * Liveness comes from frame progress, not from the WebRTC state: the peer
 * connection stays "connected" after the publisher disappears, so a torn-down
 * instance would otherwise still read as live.
 */
@Component({
  selector: 'mv-booking-tile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell],
  template: `
    <div class="bk-tile" [class.on]="live()">
      <div class="bk-head">
        <div>
          <div class="bk-title">{{ title() }}</div>
          <div class="bk-sub">{{ subtitle() }}</div>
        </div>
        <span class="bk-badge" [class]="badgeClass()">{{ badge() }}</span>
      </div>
      <mv-video-shell videoClass="bk-video" />
      <div>
        <div class="bk-chips">
          @for (source of sources(); track source.index) {
            <span class="bk-chip" [class.active]="source.active">
              SRT-{{ source.index }}{{ source.active ? ' • reading' : '' }}
            </span>
          }
        </div>
      </div>
    </div>
  `,
})
export class BookingTile {
  /** The MediaFunctionInstance name, e.g. `t1`. */
  readonly name = input.required<string>();
  readonly title = input.required<string>();
  readonly instance = input<BookingInstance | undefined>(undefined);

  private readonly registry = inject(PlayerRegistry);
  private readonly shell = viewChild.required(VideoShell);

  /** Whether frames are arriving. The page's signal chain reads this. */
  readonly live = signal(false);

  protected readonly subtitle = computed(() => {
    const inst = this.instance();
    if (!inst) return 'not deployed';
    return `${(inst.sources ?? []).length} SRT sources · ${inst.type ?? ''}`;
  });

  /**
   * Frames win; a pod that exists but has not produced yet says "deploying"
   * rather than sitting at "offline" next to a running workload.
   */
  protected readonly badge = computed(() => {
    if (this.live()) return 'live';
    return this.instance()?.replicas ? 'deploying' : 'offline';
  });

  protected readonly badgeClass = computed(() => {
    if (this.live()) return 'live';
    return this.instance()?.replicas ? 'pending' : '';
  });

  protected readonly sources = computed(() => {
    const inst = this.instance();
    const reading = inst?.liveReaderFlow ?? inst?.readerFlow;
    return (inst?.sources ?? []).map((flow, i) => ({
      index: i + 1,
      active: flow === reading,
    }));
  });

  /** The mediamtx path carrying this instance's output. */
  private get path(): string {
    return `txdarwin-${this.name()}-out`;
  }

  /** Called by the page's scene, so a hidden tab decodes nothing. */
  start(): void {
    const video = this.shell().video;
    const path = this.path;
    let last = -1;
    let pc: WhepHandle | null = null;
    let hls: HlsHandle | null = null;
    let backoff = BACKOFF_START_MS;
    let sinceReconnect = 0;

    const connect = () => {
      pc?.stop();
      pc = null;
      hls?.stop();
      hls = null;
      try {
        video.srcObject = null;
      } catch {
        // Not writable on this element; hlsPlay clears it again anyway.
      }
      pc = whep(this.registry, path, video, {
        onFail: () => {
          hls = hlsPlay(hlsUrl(path), video, { registry: this.registry });
        },
      });
    };
    connect();

    const tick = setInterval(() => {
      const moving = video.currentTime > last + PROGRESS_EPSILON;
      last = video.currentTime;
      this.live.set(moving);
      if (moving) {
        backoff = BACKOFF_START_MS;
        sinceReconnect = 0;
        return;
      }
      // Idle booking flows are the normal state — back off instead of
      // reconnecting (and leaking a fresh Hls) every tick.
      sinceReconnect += TICK_MS;
      if (sinceReconnect >= backoff) {
        sinceReconnect = 0;
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
        connect();
      }
    }, TICK_MS);

    this.registry.track({
      kind: 'timer',
      stop: () => {
        clearInterval(tick);
        pc?.stop();
        hls?.stop();
        this.live.set(false);
      },
    });
  }
}
