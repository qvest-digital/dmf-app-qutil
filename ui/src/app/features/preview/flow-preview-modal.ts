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
import { AncGrain, PreviewSession } from '../../core/api/models';
import { HlsHandle, hlsPlay } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { WhepHandle, whep } from '../../core/player/whep';
import { KvRow } from '../../shared/kv-row';
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
/** Data previews re-read the newest grain at about this rate. */
const ANC_POLL_MS = 1000;

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
  imports: [VideoShell, AudioMeters, KvRow],
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
        <!-- A data flow has no route to a browser, so there is nothing to play:
             the grain's bytes are the preview. -->
        @if (isData()) {
          @if (grain(); as g) {
            <div class="pv-anc">
              <div class="pv-anc-head">
                grain {{ g.index }} · {{ g.validSlices }} of {{ g.grainSize }} bytes readable
              </div>
              @for (el of g.elements; track $index) {
                <div class="kv">
                  <mv-kv-row label="DID / SDID">
                    {{ hex2(el.did) }} / {{ hex2(el.sdid) }}{{ el.name ? ' — ' + el.name : '' }}
                  </mv-kv-row>
                  <mv-kv-row label="line">{{ el.line }}</mv-kv-row>
                  <mv-kv-row label="data count">{{ el.dataCount }}</mv-kv-row>
                  @if (el.timecode) {
                    <mv-kv-row label="timecode" state="ok">{{ el.timecode }}</mv-kv-row>
                  }
                  <mv-kv-row label="user data" [mono]="true">{{ udwHex(el.udw) }}</mv-kv-row>
                </div>
              } @empty {
                <div class="pv-anc-note">{{ g.parseError || 'no ANC packets in this grain' }}</div>
              }
              <pre class="pv-hex">{{ hexDump(g.bytes) }}</pre>
            </div>
          }
        } @else {
          <mv-video-shell
            [videoClass]="isAudio() ? 'pv-video audio-only' : 'pv-video'"
            [controls]="true"
            [muted]="false"
          />
        }
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

  // Not `required`: a data preview renders no player at all.
  private readonly shell = viewChild(VideoShell);
  private readonly meters = viewChild.required(AudioMeters);

  protected readonly visible = signal(false);
  protected readonly title = signal('Preview');
  protected readonly state = signal('');
  protected readonly isAudio = signal(false);
  protected readonly isData = signal(false);
  protected readonly grain = signal<AncGrain | null>(null);

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
    this.isData.set(request.format === 'data');
    this.teardown();

    // Data flows provision nothing: there is no mediamtx path to add and none to
    // delete afterwards, just a grain to read. So this branch skips the whole
    // start/await/play sequence below.
    if (request.format === 'data') {
      this.pollGrain(id);
      return;
    }

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
    const video = this.shell()?.video;
    if (!video) return;
    this.pc = whep(this.registry, session.path, video, {
      onFail: () => this.playHls(session.hls, true, channels),
      onStream: (stream) => {
        this.state.set('');
        this.meters().start(stream, channels, video);
      },
    });
  }

  private playHls(src: string, isAudio: boolean, channels: number): void {
    const video = this.shell()?.video;
    if (!video) return;
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

  /**
   * Re-reads the newest grain about once a second. Deliberately a chain of
   * timeouts rather than an interval: a slow or failing read must not stack up
   * requests behind itself, and the flow only produces ~30 grains a second so
   * nothing here is trying to keep up with the data.
   */
  private pollGrain(id: string): void {
    if (this.sessionId !== id) return;
    this.api.ancGrain(id).subscribe({
      next: (grain) => {
        if (this.sessionId !== id) return;
        this.grain.set(grain);
        this.state.set('');
        this.timer = setTimeout(() => this.pollGrain(id), ANC_POLL_MS);
      },
      error: (err: { error?: { error?: string } }) => {
        if (this.sessionId !== id) return;
        // Keep the last good grain on screen; a flow that briefly has no
        // readable grain is normal while a mirror catches up.
        this.state.set(err.error?.error ?? 'grain unavailable');
        this.timer = setTimeout(() => this.pollGrain(id), ANC_POLL_MS);
      },
    });
  }

  /** Two-digit hex, the way ANC identifiers are always written. */
  protected hex2(v: number): string {
    return '0x' + v.toString(16).padStart(2, '0');
  }

  protected udwHex(udw: number[]): string {
    return udw.map((v) => v.toString(16).padStart(2, '0')).join(' ');
  }

  /** Classic hex dump: an offset, sixteen bytes, then their ASCII. */
  protected hexDump(hex: string): string {
    const bytes: number[] = [];
    for (let i = 0; i + 1 < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const lines: string[] = [];
    for (let off = 0; off < bytes.length; off += 16) {
      const row = bytes.slice(off, off + 16);
      const hexPart = row
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ')
        .padEnd(47, ' ');
      const ascii = row.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
      lines.push(`${off.toString(16).padStart(4, '0')}  ${hexPart}  ${ascii}`);
    }
    return lines.join('\n');
  }

  private doClose(): void {
    // The effect's first run sees no request; there is nothing open to close, and
    // the view children it would touch may not be resolved yet.
    if (!this.visible() && !this.sessionId) return;
    this.visible.set(false);
    // A data preview provisioned nothing, so there is nothing to release —
    // calling stopPreview would delete mediamtx paths that were never created.
    const wasData = this.isData();
    this.teardown();
    this.isAudio.set(false);
    this.isData.set(false);
    this.grain.set(null);
    if (wasData) {
      this.sessionId = null;
      return;
    }
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
    const video = this.shell()?.video;
    if (!video) return;
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
