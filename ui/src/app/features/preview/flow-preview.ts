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
import { AncGrain, PreviewSession } from '../../core/api/models';
import { HlsHandle, hlsPlay } from '../../core/player/hls-player';
import { PlayerRegistry } from '../../core/player/player-registry';
import { WhepHandle, WhepStats, whep } from '../../core/player/whep';
import { VideoShell } from '../../shared/video-shell';
import { AncGrainView } from './anc-grain';
import { AudioMeters, PairStream } from './audio-meters';
import { key, PreviewController, PreviewRequest } from './preview-controller';

/** A preview tolerates more rebuffering than a wall of tiles before it gives up. */
const HLS_RETRY_MS = 4000;
/**
 * How often a data preview asks for the current grain.
 *
 * A flow produces about thirty grains a second and the reader answers with
 * whichever is current, so every request lands on a different one and the rate
 * here is what decides whether a timecode counts or jumps. At half a second it
 * jumped over half the frames; at a tenth it reads as counting.
 *
 * Not the grain rate itself: matching it would be a request per frame per open
 * card, for a display that is already legible several frames apart. The poll is
 * a chain of timeouts rather than an interval, so a slow answer delays the next
 * request instead of stacking one behind it.
 */
const ANC_POLL_MS = 100;
/** Names this card as a holder of the path, so the aggregator can count holders. */
const OWNER = 'preview';
/** Pairs a card connects to at once for a wide flow: one path and one WHEP
 *  connection each, so this also caps how many run in parallel. */
const MAX_PARALLEL_CHANNELS = 12;
/**
 * First wait before a card that fell back to HLS tries WHEP again.
 *
 * HLS is the degraded state, not a destination: it costs the playlist window
 * for as long as the card is open, and whatever made WHEP fail is usually a
 * path still opening or a relay briefly unreachable rather than a network that
 * cannot carry it. Climbing back is a visible interruption though -- one
 * element cannot hold both transports -- so it backs off rather than retrying
 * on a fixed beat.
 */
const WHEP_RETRY_MS = 30000;
/** Ceiling for that backoff. */
const WHEP_RETRY_MAX_MS = 600000;
/**
 * How long a WHEP connection has to last for the backoff to start over. Below
 * this the transport is failing rather than being unlucky, and retrying it at
 * the same rate would interrupt a working HLS player for nothing.
 */
const WHEP_STABLE_MS = 60000;

/**
 * Live preview of one flow in the operator's inventory, as a card in the preview
 * column beside the metrics panel.
 *
 * Video: demo-metrics adds a mediamtx path that PULLS the flow (mxl://).
 * Audio: the media server reads the flow itself and publishes Opus, so an audio
 * preview is the same shape as a video one - a path it pulls from, torn down by
 * DELETE.
 *
 * One connection carries a stereo pair at most, however wide the flow is. A
 * flow no wider than one pair gets exactly that: one path, one connection,
 * the buttons never shown. A wider flow gets one path and one connection per
 * pair, opened together, so every pair is metered from the start and picking
 * a different one only moves which of the already-live streams the element
 * plays, with no reconnect.
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
      @if (measure()) {
        <div class="pv-meas">{{ measure() }}</div>
      }
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
  /**
   * What the transport is costing, measured rather than assumed.
   *
   * The delay a preview shows is either the browser's, which a reconnect
   * clears, or upstream of it, which nothing here can touch. Reading the
   * jitter buffer says which, so a card that is seconds late stops being a
   * question about the player.
   */
  protected readonly measure = signal('');
  protected readonly isAudio = signal(false);
  protected readonly isData = signal(false);
  /** The grain the last poll returned, or null before the first one lands. */
  protected readonly anc = signal<AncGrain | null>(null);
  /** Selectable channel pairs, empty for video and for a flow no wider than one pair. */
  protected readonly pairs = signal<number[][]>([]);
  /** The 1-based pair the publisher was last asked for. */
  protected readonly selected = signal<number[]>([]);
  /**
   * Per-channel levels, when something reports them. Nothing does since the
   * media server took over reading the flow: it publishes the pair being
   * listened to and measures nothing else, so the meters fall back to the
   * decoded stream and show that pair. A wide flow therefore meters what is
   * audible rather than claiming its other channels are silent.
   */
  protected readonly levels = signal<number[]>([]);

  /**
   * The flow this card provisioned a path for. Every async continuation checks it
   * before touching the player, so a card closed mid-handshake cannot start
   * playing a moment later.
   */
  private sessionId: string | null = null;
  /**
   * What the aggregator provisioned, kept so playback can be rebuilt without
   * asking for the path again: a hidden tab and a climb back to WHEP both
   * restart the player against a path that never went away.
   */
  private session: PreviewSession | null = null;
  private channels = 0;
  private hls: HlsHandle | null = null;
  private pc: WhepHandle | null = null;
  private multiPair = false;
  private readonly pcs = new Map<string, WhepHandle>();
  private readonly streamsByPair = new Map<string, MediaStream>();
  private readonly pairSessions = new Map<string, { pair: number[]; session: PreviewSession }>();
  private ancTimer: ReturnType<typeof setTimeout> | undefined;
  private whepTimer: ReturnType<typeof setTimeout> | undefined;
  private whepBackoffMs = WHEP_RETRY_MS;

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

    // A hidden tab has every player torn down under it, which is the whole
    // reason the registry exists. Nothing brought them back, so a tab left in
    // the background came forward showing a dead card; this is the other half.
    effect(() => {
      const visible = this.registry.visible();
      untracked(() => (visible ? this.resume() : this.hide()));
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
   * Move the publisher onto another pair.
   *
   * A wide flow has every pair connected already, so nothing here
   * reconnects: picking a different pair only changes which of the
   * already-live streams reaches the speakers. A flow with a single pair
   * never shows the buttons this is bound to.
   */
  protected pick(pair: number[]): void {
    if (this.multiPair) {
      this.selected.set(pair);
      const stream = this.streamsByPair.get(pair.join(','));
      if (stream) this.attach(stream);
      return;
    }
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
    this.channels = request.channels;
    this.title.set(request.label || id);
    this.state.set('starting preview…');
    this.isAudio.set(request.format === 'audio');
    this.isData.set(request.format === 'data');
    const pairs = request.format === 'audio' ? FlowPreview.pairsOf(request.channels) : [];
    this.pairs.set(pairs);
    this.multiPair = pairs.length > 1;

    if (this.multiPair) {
      this.startAllPairs(id, pairs);
      return;
    }

    this.api.startPreview(id, OWNER, undefined, request.audioId).subscribe({
      next: (session) => {
        if (this.sessionId !== id) return;
        this.session = session;
        this.play();
      },
      error: (err: { error?: { error?: string } }) => {
        if (this.sessionId !== id) return;
        this.state.set(`preview failed: ${err.error?.error ?? ''}`);
      },
    });
  }

  /**
   * One mediamtx path and one WHEP connection per pair, opened together.
   *
   * A stereo pair is all one connection can carry, so hearing every pair at
   * once and switching between them without a gap both need a pair's own
   * path to stay up rather than being reconfigured. `selected` names the
   * first pair before any of them answer, so the card has something to mark
   * as heard from the first frame.
   */
  private startAllPairs(id: string, pairs: number[][]): void {
    this.selected.set(pairs[0]);
    for (const pair of pairs) {
      this.api.startPreview(id, OWNER, pair).subscribe({
        next: (session) => {
          if (this.sessionId !== id) return;
          this.state.set('');
          this.pairSessions.set(pair.join(','), { pair, session });
          this.connectPair(pair, session);
        },
        error: (err: { error?: { error?: string } }) => {
          if (this.sessionId !== id) return;
          this.state.set(`preview failed: ${err.error?.error ?? ''}`);
        },
      });
    }
  }

  /**
   * Open this pair's connection. Metering only: passing no video element
   * means the connection never takes over playback on its own, which is what
   * lets several of these run for one card with only one of them heard.
   */
  private connectPair(pair: number[], session: PreviewSession): void {
    const key = pair.join(',');
    const handle = whep(this.registry, session.path, null, {
      onStream: (stream) => {
        this.streamsByPair.set(key, stream);
        if (FlowPreview.sameSelection(this.selected(), pair)) this.attach(stream);
        this.rebuildMeters();
      },
    });
    this.pcs.set(key, handle);
  }

  /** Route this pair's stream to the speakers, replacing whichever pair was heard before. */
  private attach(stream: MediaStream): void {
    const video = this.shell()?.video;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {
      // Autoplay refused; the element still shows the first frame.
    });
  }

  private static sameSelection(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  /** Feed every connected pair's stream to the meters, so a bar started once
   *  a connection completes stays live through the ones still connecting. */
  private rebuildMeters(): void {
    const sources: PairStream[] = [];
    for (const { pair } of this.pairSessions.values()) {
      const stream = this.streamsByPair.get(pair.join(','));
      if (stream) sources.push({ pair, stream });
    }
    this.meters()?.startMulti(sources, this.channels);
  }

  /** [1,2], [3,4], ... with a lone trailing channel kept on its own, capped
   *  at the six pairs a card connects to at once for a wide flow. */
  private static pairsOf(channels: number): number[][] {
    const out: number[][] = [];
    const width = Math.min(channels, MAX_PARALLEL_CHANNELS);
    for (let c = 1; c <= width; c += 2) {
      out.push(c + 1 <= width ? [c, c + 1] : [c]);
    }
    return out;
  }

  /**
   * Put the card on its best transport.
   *
   * Repeatable: this is also what a tab coming back to the foreground runs, and
   * it starts from WHEP every time rather than inheriting whatever the card
   * had degraded to before it was hidden.
   */
  private play(): void {
    const session = this.session;
    const id = this.sessionId;
    if (!session || !id) return;
    if (session.format === 'data') {
      this.state.set('');
      this.pollAnc(id);
      return;
    }
    this.whepBackoffMs = WHEP_RETRY_MS;
    this.playWhep(session);
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

  /**
   * WHEP first, HLS once its attempts are spent.
   *
   * HLS costs the playlist window: seven segments of a second, of which hls.js
   * sits three behind the live edge, so several seconds before the picture is
   * even reached. WHEP has no playlist and is the transport this is for.
   *
   * No warmup delay. The path is created on demand, so a reader arriving
   * before the first frame is held until the source is ready rather than
   * refused, and whep() carries its own budgets and rebuilds.
   */
  private playWhep(session: PreviewSession): void {
    const video = this.shell()?.video;
    if (!video) return;
    const isAudio = session.format === 'audio';
    const startedAt = Date.now();
    // whep() builds /webrtc/<path>/whep itself, so it takes the path and not
    // the address the session carries.
    this.pc = whep(this.registry, session.path, video, {
      onFail: () => {
        this.pc = null;
        // A connection that held for a while and then went is worth retrying
        // as eagerly as the first one was; one that never held is not.
        if (Date.now() - startedAt > WHEP_STABLE_MS) this.whepBackoffMs = WHEP_RETRY_MS;
        this.playHls(session);
      },
      onStream: (stream) => {
        this.state.set('');
        if (isAudio) this.meters()?.start(stream, this.channels, video);
      },
      onRetry: (attempt) => this.state.set(`reconnecting (${attempt})…`),
      onStats: (stats) => this.measure.set(FlowPreview.describe(stats)),
    });
  }

  /** The transport, what the browser is holding, the round trip, the rebuilds. */
  private static describe(stats: WhepStats): string {
    const parts = ['WebRTC'];
    if (stats.jitterDelayS != null)
      parts.push(`buffer ${Math.round(stats.jitterDelayS * 1000)} ms`);
    if (stats.rttS != null) parts.push(`rtt ${Math.round(stats.rttS * 1000)} ms`);
    if (stats.attempts) parts.push(`${stats.attempts} reconnects`);
    return parts.join(' · ');
  }

  private playHls(session: PreviewSession): void {
    const video = this.shell()?.video;
    if (!video) return;
    const isAudio = session.format === 'audio';
    this.hls = hlsPlay(session.hls, video, {
      // Without this the card's fallback player is the one decoder the
      // registry does not know about, so a hidden tab tears down every other
      // player and leaves this one running.
      registry: this.registry,
      retryMs: HLS_RETRY_MS,
      onManifest: () => {
        this.state.set('');
        if (isAudio) this.meters()?.start(null, this.channels, video);
      },
      onFatal: () => this.state.set('buffering…'),
      onLatency: (seconds) => this.measure.set(`HLS · ${seconds.toFixed(1)} s behind live`),
    });
    this.scheduleWhepRetry(session);
  }

  /**
   * Try WHEP again later.
   *
   * The HLS player has to go first: one element cannot carry both, and a WHEP
   * srcObject takes precedence over the MSE source, so leaving it up would
   * freeze the picture on whichever transport lost.
   */
  private scheduleWhepRetry(session: PreviewSession): void {
    if (this.whepTimer !== undefined) clearTimeout(this.whepTimer);
    // The first fall waits the base interval; every climb back that fails
    // doubles what the next one waits, so a transport that cannot work here
    // stops interrupting a working HLS player.
    const wait = this.whepBackoffMs;
    this.whepBackoffMs = Math.min(this.whepBackoffMs * 2, WHEP_RETRY_MAX_MS);
    this.whepTimer = setTimeout(() => {
      this.whepTimer = undefined;
      if (this.session !== session) return;
      this.hls?.stop();
      this.hls = null;
      this.meters()?.stop();
      this.state.set('trying WebRTC again…');
      this.playWhep(session);
    }, wait);
  }

  /** Come back to the foreground on the transport a fresh card would use. */
  private resume(): void {
    if (this.multiPair) {
      if (!this.pairSessions.size || this.pcs.size) return;
      this.state.set('starting preview…');
      for (const { pair, session } of this.pairSessions.values()) this.connectPair(pair, session);
      return;
    }
    if (!this.session || this.pc || this.hls || this.ancTimer !== undefined) return;
    this.state.set('starting preview…');
    this.play();
  }

  /**
   * Go quiet while the tab is hidden. The path is left alone: the aggregator
   * reaps it on its own once nothing reads it, and holding it means a tab
   * coming forward plays from a warm source rather than reopening one.
   */
  private hide(): void {
    if (!this.session && !this.pairSessions.size) return;
    this.teardown();
    this.state.set('paused while hidden');
  }

  /** Stop playing, without touching the mediamtx path. */
  private teardown(): void {
    for (const timer of [this.ancTimer, this.whepTimer]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.ancTimer = undefined;
    this.whepTimer = undefined;
    this.meters()?.stop();
    this.hls?.stop();
    this.hls = null;
    this.pc?.stop();
    this.pc = null;
    for (const handle of this.pcs.values()) handle.stop();
    this.pcs.clear();
    this.streamsByPair.clear();
    this.measure.set('');
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
    this.session = null;
    if (!id) return;
    this.api.stopPreview(id, OWNER).subscribe({
      error: () => {
        // The path may already be gone; nothing to report to the audience.
      },
    });
  }
}
