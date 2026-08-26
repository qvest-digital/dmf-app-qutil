import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { AncGrain, PreviewSession, PreviewStatus } from '../../core/api/models';
import { HlsHandle, hlsPlay } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { WhepHandle, whep } from '../../core/player/whep';
import { VideoShell } from '../../shared/video-shell';
import { AncGrainView } from './anc-grain';
import { AudioMeters } from './audio-meters';
import { key, PreviewController, PreviewRequest } from './preview-controller';

/** Audio readiness poll: 30 tries, one a second. */
const AUDIO_TRIES = 30;
const AUDIO_POLL_MS = 1000;
/**
 * How often the levels refresh once audio is playing. The meters ease towards
 * each value, so this bounds how soon a bar starts reacting rather than how
 * smoothly it moves; the audio preview answers /status from memory, and one card
 * polls only the flow it plays.
 */
const LEVEL_POLL_MS = 100;
/** A preview tolerates more rebuffering than a wall of tiles before it gives up. */
const HLS_RETRY_MS = 4000;
/**
 * How often a data preview asks for the current grain. Fast enough that a
 * timecode reads as counting rather than jumping, and each poll is one decoded
 * grain rather than a stream.
 */
const ANC_POLL_MS = 500;
/** Names this card as a holder of the path, so the aggregator can count holders. */
const OWNER = 'preview';

/**
 * Live preview of one flow in the operator's inventory, as a card in the preview
 * column beside the metrics panel.
 *
 * Video: demo-metrics adds a mediamtx path that PULLS the flow (mxl://).
 * Audio: mediamtx's mxlSource refuses audio, so the audio-preview pod reads the
 * flow and PUSHES Opus into a publisher-mode path instead. Either way the card
 * plays a normal mediamtx path, and DELETE tears it down.
 *
 * What arrives is a stereo pair of the flow's channels, so a wide flow is heard
 * a pair at a time and the buttons pick which. Levels for every channel come
 * from the polled status rather than from the decoded stream, which only ever
 * carries the pair being listened to.
 *
 * One card owns one <video> for as long as it is open, and closing destroys
 * both: createMediaElementSource throws if the meters are ever rebuilt against a
 * fresh element, so an element must never be handed to a second preview.
 *
 * Data: ANC has no transport to a browser at all, so the card holds no player
 * and polls decoded grains instead.
 */
@Component({
  selector: 'mv-flow-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VideoShell, AudioMeters, AncGrainView],
  template: `
    <div class="pv-card">
      <div class="pv-head">
        <span>{{ title() }}</span>
        <button class="btn" type="button" (click)="close()">✕</button>
      </div>
      @if (isData()) {
        <mv-anc-grain [grain]="anc()" />
      } @else {
        <!-- Audio flows have nothing to show, so the meters take the video's place
             and the element collapses to just its transport controls (volume and
             mute still matter). -->
        <mv-audio-meters [show]="isAudio()" [sourcePeaks]="levels()" [selected]="selected()" />
        @if (pairs().length > 1) {
          <div class="pv-chans">
            <span class="pv-chans-label">listen to</span>
            @for (pair of pairs(); track pair[0]) {
              <button
                class="btn pv-chan"
                type="button"
                [class.on]="isPlaying(pair)"
                (click)="pick(pair)"
              >
                {{ pairLabel(pair) }}
              </button>
            }
          </div>
        }
        <mv-video-shell
          [videoClass]="isAudio() ? 'pv-video audio-only' : 'pv-video'"
          [controls]="true"
          [muted]="false"
        />
      }
      <div class="pv-state">{{ state() }}</div>
    </div>
  `,
})
export class FlowPreview {
  readonly request = input.required<PreviewRequest>();

  private readonly api = inject(MetricsApi);
  private readonly registry = inject(PlayerRegistry);
  private readonly controller = inject(PreviewController);

  // Optional: a data card renders neither, because ANC has nothing to play.
  private readonly shell = viewChild(VideoShell);
  private readonly meters = viewChild(AudioMeters);

  protected readonly title = signal('Preview');
  protected readonly state = signal('');
  protected readonly isAudio = signal(false);
  protected readonly isData = signal(false);
  /** The grain the last poll returned, or null before the first one lands. */
  protected readonly anc = signal<AncGrain | null>(null);
  /** Selectable channel pairs, empty for video and for a flow no wider than one pair. */
  protected readonly pairs = signal<number[][]>([]);
  /** The 1-based pair on air, as reported rather than as requested. */
  protected readonly selected = signal<number[]>([]);
  /** dBFS per source channel, straight from the polled status. */
  protected readonly levels = signal<number[]>([]);

  /**
   * The flow this card provisioned a path for. Every async continuation checks it
   * before touching the player, so a card closed mid-handshake cannot start
   * playing a moment later.
   */
  private sessionId: string | null = null;
  private hls: HlsHandle | null = null;
  private pc: WhepHandle | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private levelTimer: ReturnType<typeof setTimeout> | undefined;
  private ancTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.teardown();
      this.releasePath();
    });

    // Runs once per card: the request is fixed for as long as the card is open.
    // untracked keeps the signals start() writes out of the dependency set.
    effect(() => {
      const request = this.request();
      untracked(() => this.start(request));
    });
  }

  protected close(): void {
    // Routed through the controller so the column and the cards it renders cannot
    // disagree about what is open; the card's own teardown follows from being
    // destroyed.
    this.controller.close(key(this.request()));
  }

  protected pairLabel(pair: number[]): string {
    return pair.join('/');
  }

  protected isPlaying(pair: number[]): boolean {
    const on = this.selected();
    return pair.every((c) => on.includes(c));
  }

  /**
   * Move the publisher onto another pair. The mediamtx path and its publisher
   * stay up, so nothing is torn down here and the element keeps playing through
   * the switch; the reported selection follows within a poll.
   */
  protected pick(pair: number[]): void {
    const id = this.sessionId;
    if (!id) return;
    this.selected.set(pair);
    this.api.selectPreviewChannels(id, pair, OWNER).subscribe({
      error: (err: { error?: { error?: string } }) => {
        if (this.sessionId !== id) return;
        this.state.set(`channel switch failed: ${err.error?.error ?? ''}`);
      },
    });
  }

  private start(request: PreviewRequest): void {
    const id = request.id;
    this.sessionId = id;
    this.title.set(request.label || id);
    this.state.set('starting preview…');
    this.isAudio.set(request.format === 'audio');
    this.isData.set(request.format === 'data');
    this.pairs.set(request.format === 'audio' ? FlowPreview.pairsOf(request.channels) : []);

    this.api.startPreview(id, OWNER, undefined, request.audioId).subscribe({
      next: (session) => {
        if (this.sessionId !== id) return;
        if (session.format === 'data') {
          this.state.set('');
          this.pollAnc(id);
          return;
        }
        if (session.format === 'audio') {
          this.awaitAudio(id, session, request.channels, AUDIO_TRIES);
          return;
        }
        this.playVideo(session);
      },
      error: (err: { error?: { error?: string } }) => {
        if (this.sessionId !== id) return;
        this.state.set(`preview failed: ${err.error?.error ?? ''}`);
      },
    });
  }

  /** [1,2], [3,4], ... with a lone trailing channel kept on its own. */
  private static pairsOf(channels: number): number[][] {
    const out: number[][] = [];
    for (let c = 1; c <= channels; c += 2) {
      out.push(c + 1 <= channels ? [c, c + 1] : [c]);
    }
    return out;
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
          this.applyStatus(status);
          this.playAudio(session, status.channels || channels);
          this.pollLevels(id);
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
   * Keep the levels coming while the preview plays. Only the two audible
   * channels reach the browser, so every other channel's level has to be asked
   * for; the bars are a peak meter at this rate, not a continuous one.
   */
  private pollLevels(id: string): void {
    this.api.previewStatus(id).subscribe({
      next: (status) => {
        if (this.sessionId !== id) return;
        this.applyStatus(status);
        this.levelTimer = setTimeout(() => this.pollLevels(id), LEVEL_POLL_MS);
      },
      error: () => {
        if (this.sessionId !== id) return;
        // A dropped poll is not a dropped preview: the audio keeps playing and
        // the next poll is the recovery.
        this.levelTimer = setTimeout(() => this.pollLevels(id), LEVEL_POLL_MS);
      },
    });
  }

  /**
   * Keep asking for the current grain. A failed poll keeps the last grain on
   * screen and says why: an ANC flow that stops being readable here is worth
   * seeing as an error beside the last packets rather than as a blank card.
   */
  private pollAnc(id: string): void {
    this.api.ancGrain(id).subscribe({
      next: (grain) => {
        if (this.sessionId !== id) return;
        this.anc.set(grain);
        this.ancTimer = setTimeout(() => this.pollAnc(id), ANC_POLL_MS);
      },
      error: (err: { error?: { error?: string } }) => {
        if (this.sessionId !== id) return;
        this.state.set(`grain read failed: ${err.error?.error ?? ''}`);
        this.ancTimer = setTimeout(() => this.pollAnc(id), ANC_POLL_MS);
      },
    });
  }

  private applyStatus(status: PreviewStatus): void {
    this.levels.set(status.channelPeakDb ?? []);
    // An audio-preview without the pair selection reports neither, and guessing
    // [1, 2] would light a button for something nobody chose.
    if (status.selected?.length) this.selected.set(status.selected);
    if (status.channels && this.pairs().length === 0) {
      this.pairs.set(FlowPreview.pairsOf(status.channels));
    }
  }

  /**
   * WHEP first for video, HLS on failure.
   *
   * HLS costs the playlist window: seven segments of a second, of which hls.js
   * sits three behind the live edge, so several seconds before the picture is
   * even reached. WHEP has no playlist and is the transport this is for.
   *
   * No warmup delay. The path is created on demand, so a reader arriving
   * before the first frame is held until the source is ready rather than
   * refused, and whep() carries its own connect timeout.
   */
  private playVideo(session: PreviewSession): void {
    const video = this.shell()?.video;
    if (!video) return;
    // whep() builds /webrtc/<path>/whep itself, so it takes the path and not
    // the address the session carries.
    this.pc = whep(this.registry, session.path, video, {
      onFail: () => {
        this.pc = null;
        this.playHls(session.hls, false, 0);
      },
      onStream: () => this.state.set(''),
    });
  }

  /**
   * WHEP first for audio — sub-second, and the meters get the raw stream — with
   * HLS on failure.
   */
  private playAudio(session: PreviewSession, channels: number): void {
    const video = this.shell()?.video;
    if (!video) return;
    this.pc = whep(this.registry, session.path, video, {
      onFail: () => {
        this.pc = null;
        this.playHls(session.hls, true, channels);
      },
      onStream: (stream) => {
        this.state.set('');
        this.meters()?.start(stream, channels, video);
      },
    });
  }

  private playHls(src: string, isAudio: boolean, channels: number): void {
    const video = this.shell()?.video;
    if (!video) return;
    this.hls = hlsPlay(src, video, {
      // Without this the card's fallback player is the one decoder the
      // registry does not know about, so a hidden tab tears down every other
      // player and leaves this one running.
      registry: this.registry,
      retryMs: HLS_RETRY_MS,
      liveMaxLatencyDurationCount: null,
      onManifest: () => {
        this.state.set('');
        if (isAudio) this.meters()?.start(null, channels, video);
      },
      onFatal: () => this.state.set('buffering…'),
    });
  }

  /** Stop playing, without touching the mediamtx path. */
  private teardown(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.levelTimer !== undefined) {
      clearTimeout(this.levelTimer);
      this.levelTimer = undefined;
    }
    if (this.ancTimer !== undefined) {
      clearTimeout(this.ancTimer);
      this.ancTimer = undefined;
    }
    this.meters()?.stop();
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

  /** Drop the mediamtx path (and any audio publisher) this card provisioned. */
  private releasePath(): void {
    const id = this.sessionId;
    this.sessionId = null;
    if (!id) return;
    this.api.stopPreview(id, OWNER).subscribe({
      error: () => {
        // The path may already be gone; nothing to report to the audience.
      },
    });
  }
}
