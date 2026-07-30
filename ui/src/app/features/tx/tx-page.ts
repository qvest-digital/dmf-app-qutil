import { ChangeDetectionStrategy, Component, inject, signal, viewChild } from '@angular/core';
import { hlsPlay, hlsUrl } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { useScene } from '../../core/player/scene';
import { whep } from '../../core/player/whep';
import { VideoShell } from '../../shared/video-shell';

interface TxSource {
  path: string;
  label: string;
  /**
   * txdarwin-out is Main-profile H264 (avc1.4d.., hardcoded in the compositor's
   * x264enc) which browser WebRTC decoders render black — they connect, so the
   * WHEP fallback never fires. It plays over HLS/MSE like the 2x2 composite.
   * srt-camera is a live ingest where sub-second latency is the point, so it stays
   * on WebRTC (WHEP) with an HLS fallback; it is encoded baseline (see
   * mediamtx.yml srt-camera) so the browser can decode it.
   */
  hlsOnly: boolean;
}

const SOURCES: TxSource[] = [
  { path: 'txdarwin-out', label: 'txDarwin Out', hlsOnly: true },
  { path: 'srt-camera', label: 'SRT Camera', hlsOnly: false },
  { path: 'txdarwin-ac3demo-out', label: 'Booking Out (ac3demo)', hlsOnly: false },
];

/**
 * One player, source-switchable between the txDarwin output and the SRT-camera
 * ingest. Started on route entry, so it does not pull those mediamtx encoders
 * until someone looks.
 */
@Component({
  selector: 'mv-tx-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell],
  template: `
    <main class="tx-main">
      <div class="tx-toggle">
        @for (source of sources; track source.path) {
          <button
            class="txbtn"
            type="button"
            [class.active]="source.path === active().path"
            (click)="select(source)"
          >
            {{ source.label }}
          </button>
        }
      </div>
      <mv-video-shell videoClass="tx-video" />
    </main>
  `,
})
export class TxPage {
  private readonly registry = inject(PlayerRegistry);
  private readonly shell = viewChild.required(VideoShell);

  protected readonly sources = SOURCES;
  protected readonly active = signal(SOURCES[0]);

  constructor() {
    useScene(() => this.load());
  }

  protected select(source: TxSource): void {
    if (source.path === this.active().path) return;
    this.active.set(source);
    // Drop the previous source's players before attaching the new one; both are
    // registered, so this is the same teardown a route change would do.
    this.registry.teardownAll();
    this.load();
  }

  private load(): void {
    const source = this.active();
    const video = this.shell().video;
    if (source.hlsOnly) {
      hlsPlay(hlsUrl(source.path), video, { registry: this.registry });
      return;
    }
    whep(this.registry, source.path, video, {
      onFail: () => hlsPlay(hlsUrl(source.path), video, { registry: this.registry }),
    });
  }
}
