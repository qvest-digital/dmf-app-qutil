import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { hlsPlay, hlsUrl } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { useScene } from '../../core/player/scene';
import { VideoShell } from '../../shared/video-shell';

/**
 * The 2x2 mosaic the compositor pod RTSP-publishes to mediamtx.
 *
 * HLS, not WHEP: it is a 2592x1440 Main-profile H264 stream, which browser WebRTC
 * decoders choke on (they connect but render black) while HLS/MSE handles it fine.
 * It is a latency-tolerant overview anyway; the live per-flow tiles stay WebRTC.
 */
@Component({
  selector: 'mv-composite-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell],
  template: `
    <main class="tx-main">
      <div class="pc-badge">
        <span class="pc-mxl">Composite</span>
        <span class="pc-origin">2×2 mosaic</span>
        <span class="pc-node">MXL-1…4</span>
      </div>
      <mv-video-shell videoClass="tx-video" />
    </main>
  `,
})
export class CompositePage {
  private readonly registry = inject(PlayerRegistry);
  private readonly shell = viewChild.required(VideoShell);

  constructor() {
    useScene(() => {
      hlsPlay(hlsUrl('composite'), this.shell().video, { registry: this.registry });
    });
  }
}
