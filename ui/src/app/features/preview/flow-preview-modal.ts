import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  DestroyRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { PreviewSession } from '../../core/api/models';
import { HlsHandle, hlsPlay } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { WhepHandle, whep } from '../../core/player/whep';
import { VideoShell } from '../../shared/video-shell';
import { AudioMeters } from './audio-meters';
import { PreviewController, PreviewRequest } from './preview-controller';

/** Give mediamtx a moment to open the reader and cut the first segment. */
const VIDEO_WARMUP_MS = 900;
/** Audio readiness poll: 30 tries, one a second. */
const AUDIO_TRIES = 30;
const AUDIO_POLL_MS = 1000;
/** The preview tolerates more rebuffering than a tile before it gives up. */
const HLS_RETRY_MS = 4000;

/**
 * Live preview of any flow in the operator's inventory.
 *
 * Video: demo-metrics adds a mediamtx path that PULLS the flow (mxl://).
 * Audio: mediamtx's mxlSource refuses audio, so the audio-preview pod reads the
 * flow and PUSHES Opus into a publisher-mode path instead. Either way the overlay
 * plays a normal mediamtx path, and DELETE tears it down.
 *
 * The component is always mounted and only toggles `.show`, because the <video>
 * it owns must be stable: createMediaElementSource throws if the meters are ever
 * rebuilt against a fresh element.
 */
@Component({
  selector: 'mv-flow-preview-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell, AudioMeters],
  template: `
    <div class="pv" [class.show]="visible()" (click)="onBackdrop($event)">
      <div class="pv-card">
        <div class="pv-head">
          <span>{{ title() }}</span>
          <button class="btn" type="button" (click)="close()">✕</button>
        </div>
        <!-- Audio flows have nothing to show, so the meters take the video's place
             and the element collapses to just its transport controls (volume and
             mute still matter). -->
        <mv-audio-meters [show]="isAudio()" />
        <mv-video-shell
          [videoClass]="isAudio() ? 'pv-video audio-only' : 'pv-video'"
          [controls]="true"
          [muted]="false"
        />
        <div class="pv-state">{{ state() }}</div>
      </div>
    </div>
  `,
})
export class FlowPreviewModal {
  private readonly api = inject(MetricsApi);
  private readonly registry = inject(PlayerRegistry);
  private readonly controller = inject(PreviewController);
  private readonly doc = inject(DOCUMENT);

  private readonly shell = viewChild.required(VideoShell);
  private readonly meters = viewChild.required(AudioMeters);

  protected readonly visible = signal(false);
  protected readonly title = signal('Preview');
  protected readonly state = signal('');
  protected readonly isAudio = signal(false);

  /**
   * The flow whose preview is current. Every async continuation checks it before
   * touching the player, so a preview closed or replaced mid-handshake cannot
   * take over the overlay a moment later.
   */
  private sessionId: string | null = null;
  private hls: HlsHandle | null = null;
  private pc: WhepHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.visible()) this.close();
    };
    this.doc.addEventListener('keydown', onKeydown);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('keydown', onKeydown);
      // Same guarded path as closing: an overlay that never opened has no player
      // to stop and no mediamtx path to release.
      this.doClose();
    });

    effect(() => {
      const request = this.controller.request();
      if (request) this.open(request);
      else this.doClose();
    });
  }

  protected close(): void {
    // Routed through the controller so the request signal and the overlay cannot
    // disagree about whether a preview is open.
    this.controller.close();
  }

  protected onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }

  private open(request: PreviewRequest): void {
    const id = request.id;
    this.sessionId = id;
    this.visible.set(true);
    this.title.set(request.label || id);
    this.state.set('starting preview…');
    this.isAudio.set(request.format === 'audio');
    this.teardown();

    this.api.startPreview(id).subscribe({
      next: (session) => {
        if (this.sessionId !== id) return;
        if (session.format === 'audio') {
          this.awaitAudio(id, session, request.channels, AUDIO_TRIES);
          return;
        }
        this.timer = setTimeout(() => {
          if (this.sessionId === id) this.playHls(session.hls, false, 0);
        }, VIDEO_WARMUP_MS);
      },
      error: (err: { error?: { error?: string } }) => {
        if (this.sessionId !== id) return;
        this.state.set(`preview failed: ${err.error?.error ?? ''}`);
      },
    });
  }

  /**
   * /start only spawns the reader: opening the flow can take seconds while the
   * intent shim waits for the gateway to mirror it, and it can fail. Poll until it
   * is actually producing, so a dead session says so instead of spinning forever.
   */
  private awaitAudio(id: string, session: PreviewSession, channels: number, tries: number): void {
    if (this.sessionId !== id) return;
    const again = () => {
      this.timer = setTimeout(
        () => this.awaitAudio(id, session, channels, tries - 1),
        AUDIO_POLL_MS,
      );
    };
    this.api.previewStatus(id).subscribe({
      next: (status) => {
        if (this.sessionId !== id) return;
        if (status.error) {
          this.state.set(`preview failed: ${status.error}`);
          return;
        }
        if (status.running && (status.samples ?? 0) > 0) {
          this.state.set('connecting audio…');
          this.playAudio(session, status.channels || channels);
          return;
        }
        if (tries <= 0) {
          this.state.set('preview timed out — flow produced no audio');
          return;
        }
        this.state.set('waiting for the flow to be readable here…');
        again();
      },
      error: () => {
        if (this.sessionId !== id) return;
        if (tries <= 0) {
          this.state.set('preview status unavailable');
          return;
        }
        again();
      },
    });
  }

  /**
   * WHEP first for audio — sub-second, and the meters get the raw stream — with
   * HLS on failure, the same order the per-flow tiles use.
   */
  private playAudio(session: PreviewSession, channels: number): void {
    const video = this.shell().video;
    this.pc = whep(this.registry, session.path, video, {
      onFail: () => this.playHls(session.hls, true, channels),
      onStream: (stream) => {
        this.state.set('');
        this.meters().start(stream, channels, video);
      },
    });
  }

  private playHls(src: string, isAudio: boolean, channels: number): void {
    const video = this.shell().video;
    this.hls = hlsPlay(src, video, {
      retryMs: HLS_RETRY_MS,
      liveMaxLatencyDurationCount: null,
      onManifest: () => {
        this.state.set('');
        if (isAudio) this.meters().start(null, channels, video);
      },
      onFatal: () => this.state.set('buffering…'),
    });
  }

  private doClose(): void {
    // The effect's first run sees no request; there is nothing open to close, and
    // the view children it would touch may not be resolved yet.
    if (!this.visible() && !this.sessionId) return;
    this.visible.set(false);
    this.teardown();
    this.isAudio.set(false);
    this.releasePath();
  }

  /** Stop playing, without touching the mediamtx path. */
  private teardown(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.meters().stop();
    this.hls?.stop();
    this.hls = null;
    this.pc?.stop();
    this.pc = null;
    const video = this.shell().video;
    try {
      video.pause();
      video.srcObject = null;
      video.removeAttribute('src');
      video.load();
    } catch {
      // The element is mid-teardown; nothing further to reset.
    }
  }

  /** Drop the mediamtx path (and any audio publisher) the preview provisioned. */
  private releasePath(): void {
    const id = this.sessionId;
    this.sessionId = null;
    if (!id) return;
    this.api.stopPreview(id).subscribe({
      error: () => {
        // The path may already be gone; nothing to report to the audience.
      },
    });
  }
}
