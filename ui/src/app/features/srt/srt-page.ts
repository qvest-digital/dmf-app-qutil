import { ChangeDetectionStrategy, Component, inject, viewChild } from '@angular/core';
import { hlsPlay, hlsUrl } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { useScene } from '../../core/player/scene';
import { whep } from '../../core/player/whep';
import { VideoShell } from '../../shared/video-shell';

/** The media server path the SRT ingest publishes into. */
const SOURCE_PATH = 'srt-camera';

/**
 * The SRT ingest, played over WebRTC with an HLS fallback.
 *
 * Sub-second latency is the point of a live ingest, so WHEP is tried first.
 * The ingest is encoded baseline H264, which browser WebRTC decoders render;
 * a higher profile connects but paints black, and the fallback never fires
 * because the connection itself succeeded.
 *
 * Players start on route entry, so no encoder runs until someone looks.
 */
@Component({
  selector: 'mv-srt-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell],
  template: `
    <main class="tx-main">
      <mv-video-shell videoClass="tx-video" />
    </main>
  `,
})
export class SrtPage {
  private readonly registry = inject(PlayerRegistry);
  private readonly shell = viewChild.required(VideoShell);

  constructor() {
    useScene(() => this.load());
  }

  private load(): void {
    const video = this.shell().video;
    whep(this.registry, SOURCE_PATH, video, {
      onFail: () => hlsPlay(hlsUrl(SOURCE_PATH), video, { registry: this.registry }),
    });
  }
}
