import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  viewChild,
} from '@angular/core';

// The buffer type argument is explicit because the WebAudio read methods only
// accept views over a plain ArrayBuffer, not a SharedArrayBuffer.
interface ChannelMeter {
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  peak: number;
  hold: number;
}

/** Peak-hold state for a bar whose level arrives from outside this component. */
interface HoldState {
  peak: number;
  hold: number;
}

interface Visualisation {
  srcs: AudioNode[];
  channels: ChannelMeter[];
  spectrum: AnalyserNode;
  bins: Uint8Array<ArrayBuffer>;
}

/** One pair's decoded stream, ready to meter. */
export interface PairStream {
  pair: number[];
  stream: MediaStream;
}

/** The string key a pair is tracked under, e.g. [1, 2] -> "1,2". Shared with
 *  flow-preview.ts so both agree on the format. */
export function pairKey(pair: number[]): string {
  return pair.join(',');
}

/** Peak-hold dwell before the marker starts sliding back down. */
const PEAK_HOLD_MS = 900;
/** How fast it slides once the dwell is over, in bar heights per second. */
const PEAK_DECAY_PER_SEC = 0.7;
/** Above this the bar turns orange - the usual "too hot" cue. */
const HOT_DBFS = -6;
const SPECTRUM_COLUMNS = 64;
/**
 * Time constants for a bar chasing a new level, rising and falling. Asymmetric
 * because that is what a level meter does: catch a transient, let it go slowly
 * enough to read.
 */
const ATTACK_MS = 25;
const RELEASE_MS = 220;

/**
 * One step of meter ballistics, as a first-order filter towards the target.
 *
 * Reported levels arrive a few times a second and the canvas redraws sixty
 * times, so what happens between two reported values decides whether the bars
 * look alive. A rate limit does not: it reaches the target and then holds
 * perfectly still until the next one arrives, which is a step at poll rate for
 * every change smaller than the rate allows. Easing towards the target instead
 * never arrives, so every frame moves. It is the same treatment the spectrum
 * beside these bars gets from `AnalyserNode.smoothingTimeConstant`, which is
 * why that half already looks continuous.
 */
export function advanceLevelDb(current: number, target: number, dtMs: number): number {
  const tau = target >= current ? ATTACK_MS : RELEASE_MS;
  const alpha = 1 - Math.exp(-Math.max(dtMs, 0) / tau);
  return current + (target - current) * alpha;
}

/** Past this many bars the strip needs the wider half of the canvas. */
const WIDE_STRIP_CHANNELS = 8;

/**
 * Level meters and a spectrum for an audio preview.
 *
 * The strip carries one bar per source channel. Without reported levels only
 * the pair being listened to is measured, since the media server publishes
 * that pair and measures nothing else, so those two bars sit at the positions
 * `selected` names and the rest carry no level at all. A bar drawn from no
 * measurement would read as silence, which is why an unmeasured channel keeps
 * its frame and its number but shows neither a level nor a peak. The spectrum
 * comes from the same stream.
 *
 * sourcePeaks stays as an input for a reporter that measures every channel,
 * should one exist again; with none the bars ease towards the measured values
 * the same way, because the easing is what keeps a bar moving between frames
 * rather than stepping at whatever rate a number arrives.
 */
@Component({
  selector: 'mv-audio-meters',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <canvas #canvas class="pv-audio" [class.show]="show()" width="1760" height="440"></canvas>
  `,
})
export class AudioMeters {
  readonly show = input(false);
  /** dBFS per source channel, as /status reports it. */
  readonly sourcePeaks = input<number[]>([]);
  /** The 1-based source channels currently audible. */
  readonly selected = input<number[]>([]);

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /**
   * Created once and reused: createMediaElementSource throws on a second call for
   * the same element, so a re-opened preview must not build a new one.
   */
  private context: AudioContext | null = null;
  private elementSource: MediaElementAudioSourceNode | null = null;
  /**
   * Volume for the graph when the graph is what reaches the speakers. Driven
   * from the element, whose transport controls the operator still uses.
   */
  private gain: GainNode | null = null;
  private volumeFrom: HTMLVideoElement | null = null;
  private readonly syncVolume = () => {
    const element = this.volumeFrom;
    if (this.gain && element) this.gain.gain.value = element.muted ? 0 : element.volume;
  };

  private viz: Visualisation | null = null;
  /** Source channels the strip draws a bar for, which is the flow's width. */
  private width = 2;
  /** The selection the graph was built for; anything else is not on air yet. */
  private startedFor: number[] = [];
  /** True whenever multi-pair mode is active (startMulti has run): every bar
   *  reads from its own always-connected stream rather than the single
   *  decoded stream, so there is no reconnect gap left for the bars or the
   *  spectrum to hide. */
  private perPairMode = false;
  /** Each connected pair's own stream node, keyed by "1,2" etc, so the
   *  spectrum can follow the selection without touching the bars. */
  private readonly pairTaps = new Map<string, AudioNode>();
  /** Which tap currently feeds the spectrum analyser. */
  private spectrumFrom: AudioNode | null = null;
  private frame = 0;
  /** Displayed level per bar, in dBFS, carried between frames by the ballistics. */
  private levelsDb: number[] = [];
  private lastFrameAt = 0;
  /**
   * Kept across frames so the reported levels, which arrive once a poll rather
   * than once a frame, still read as meters rather than as a value that jumps
   * and freezes.
   */
  private sourceHold: HoldState[] = [];

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /**
   * @param stream the WHEP MediaStream, or null when HLS/MSE is driving the element
   * @param element the <video> actually making the sound
   */
  start(stream: MediaStream | null, channels: number, element: HTMLVideoElement): void {
    this.stop();
    try {
      this.context ??= new AudioContext();
    } catch {
      return; // No WebAudio: the preview still plays, just without meters.
    }
    const ctx = this.context;
    if (ctx.state === 'suspended') void ctx.resume();

    let src: AudioNode;
    try {
      // MediaStream (WHEP): tap the stream and leave the element to make the
      // sound -- routing to destination as well would play it twice. HLS/MSE: the
      // graph MUST reach destination or the element goes silent.
      if (stream) {
        src = ctx.createMediaStreamSource(stream);
      } else {
        this.elementSource ??= ctx.createMediaElementSource(element);
        src = this.elementSource;
      }
    } catch {
      return;
    }

    // createMediaElementSource takes an element's output away for good, and
    // the node it returns is not a route for a MediaStream. So once HLS has
    // run on this element, a later WHEP attempt on the same card cannot leave
    // the sound to the element: the stream has to carry it, through a gain the
    // element's own volume and mute still govern. Without this a card that
    // recovers from HLS back to WHEP plays silently for the rest of its life.
    const streamDrivesOutput = stream !== null && this.elementSource !== null;

    this.width = Math.max(channels || 2, 1);
    this.startedFor = this.selected().slice();
    // Only the published pair reaches the graph, however wide the flow is, so
    // the splitter follows the decoded stream rather than the channel count.
    const decoded = Math.max(src.channelCount || 2, 1);
    const splitter = ctx.createChannelSplitter(decoded);
    src.connect(splitter);

    const meters: ChannelMeter[] = [];
    for (let i = 0; i < decoded; i++) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.4;
      splitter.connect(analyser, i);
      meters.push({
        analyser,
        samples: new Float32Array(analyser.fftSize),
        peak: 0,
        hold: 0,
      });
    }

    const spectrum = ctx.createAnalyser();
    spectrum.fftSize = 1024;
    spectrum.smoothingTimeConstant = 0.7;
    src.connect(spectrum);
    if (!stream) {
      src.connect(ctx.destination);
    } else if (streamDrivesOutput) {
      this.gain = ctx.createGain();
      src.connect(this.gain);
      this.gain.connect(ctx.destination);
      this.volumeFrom = element;
      element.addEventListener('volumechange', this.syncVolume);
      this.syncVolume();
    }

    this.viz = {
      srcs: [src],
      channels: meters,
      spectrum,
      bins: new Uint8Array(spectrum.frequencyBinCount),
    };
    this.draw();
  }

  /**
   * Meter every pair of a wide flow at once, rather than only the one
   * published. Nothing here tears down when the selection changes, so every
   * bar stays measured through a pair switch; only the spectrum, and which
   * bar reads as the one heard, follow it.
   */
  startMulti(sources: PairStream[], channels: number): void {
    this.stop();
    try {
      this.context ??= new AudioContext();
    } catch {
      return;
    }
    const ctx = this.context;
    if (ctx.state === 'suspended') void ctx.resume();

    this.width = Math.max(channels || 2, 1);
    this.perPairMode = true;

    const srcs: AudioNode[] = [];
    const meters: ChannelMeter[] = new Array(this.width);
    for (const { pair, stream } of sources) {
      let src: AudioNode;
      try {
        src = ctx.createMediaStreamSource(stream);
      } catch {
        continue;
      }
      srcs.push(src);
      this.pairTaps.set(pairKey(pair), src);

      const decoded = Math.max(src.channelCount || pair.length, 1);
      const splitter = ctx.createChannelSplitter(decoded);
      src.connect(splitter);
      pair.forEach((channelNumber, i) => {
        if (i >= decoded) return;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.4;
        splitter.connect(analyser, i);
        meters[channelNumber - 1] = {
          analyser,
          samples: new Float32Array(analyser.fftSize),
          peak: 0,
          hold: 0,
        };
      });
    }
    if (!srcs.length) return;

    const spectrum = ctx.createAnalyser();
    spectrum.fftSize = 1024;
    spectrum.smoothingTimeConstant = 0.7;

    this.viz = {
      srcs,
      channels: meters,
      spectrum,
      bins: new Uint8Array(spectrum.frequencyBinCount),
    };
    this.draw();
  }

  /** Keep the spectrum on the pair currently heard, without touching the bars. */
  private syncSpectrum(): void {
    if (!this.perPairMode || !this.viz) return;
    const pair = this.selected();
    const wanted = pair.length ? (this.pairTaps.get(pairKey(pair)) ?? null) : null;
    if (wanted === this.spectrumFrom) return;
    if (this.spectrumFrom) this.spectrumFrom.disconnect(this.viz.spectrum);
    if (wanted) wanted.connect(this.viz.spectrum);
    this.spectrumFrom = wanted;
  }

  stop(): void {
    // Nothing was ever drawn if neither the loop nor the graph is up, and in that
    // case there is no reason to touch the canvas at all.
    const wasRunning = this.frame !== 0 || this.viz !== null;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    if (this.viz) {
      for (const src of this.viz.srcs) {
        try {
          src.disconnect();
        } catch {
          // Already detached.
        }
      }
      this.viz = null;
    }
    if (this.volumeFrom) {
      this.volumeFrom.removeEventListener('volumechange', this.syncVolume);
      this.volumeFrom = null;
    }
    if (this.gain) {
      try {
        this.gain.disconnect();
      } catch {
        // Already detached.
      }
      this.gain = null;
    }
    this.sourceHold = [];
    this.levelsDb = [];
    this.startedFor = [];
    this.perPairMode = false;
    this.pairTaps.clear();
    this.spectrumFrom = null;
    this.lastFrameAt = 0;
    if (!wasRunning) return;
    const canvas = this.canvasRef().nativeElement;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  private static sameSelection(a: number[], b: number[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }

  /** -60..0 dBFS -> 0..1 */
  private static norm(db: number): number {
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  /**
   * One peak-hold step. The slide is per second rather than per frame: rAF runs
   * at whatever rate the browser is willing to, so a per-frame step makes the
   * marker fall faster on a fast display than on a slow one.
   */
  private static advance(state: HoldState, v: number, dtMs: number): void {
    if (v >= state.peak) {
      state.peak = v;
      state.hold = performance.now();
    } else if (performance.now() - state.hold > PEAK_HOLD_MS) {
      state.peak = Math.max(v, state.peak - (PEAK_DECAY_PER_SEC * dtMs) / 1000);
    }
  }

  private draw(): void {
    this.frame = requestAnimationFrame(() => this.draw());
    const viz = this.viz;
    if (!viz) return;
    this.syncSpectrum();

    const canvas = this.canvasRef().nativeElement;
    const g = canvas.getContext('2d');
    if (!g) return;
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);

    const peaks = this.sourcePeaks();
    const count = peaks.length || this.width;
    const pad = 18;
    // A wide flow gets more of the canvas: twelve bars in a third of it leave
    // no room for a channel number under each one.
    const barsW = Math.round(W * (count > WIDE_STRIP_CHANNELS ? 0.5 : 0.34));
    const specX = barsW + pad * 2;
    // Two label lines under every bar, the channel and its level.
    const barHeight = H - pad * 2 - 28;

    // Wall clock rather than a fixed step: rAF is throttled in a background tab
    // and skips frames under load, and a decay measured in frames would run at
    // whatever rate the browser felt like.
    const now = performance.now();
    const dt = this.lastFrameAt ? now - this.lastFrameAt : 0;
    this.lastFrameAt = now;

    // A path carries the flow's first channels until it is configured with a
    // pair, and the selection is unreported until the status answers, so
    // without that default a fresh card meters nothing at all.
    const reported = this.selected();
    const carried = reported.length ? reported : viz.channels.map((_, i) => i + 1);
    // Every pair is already connected in this mode, so there is no reconnect
    // gap to hide.
    const onAir =
      this.perPairMode || peaks.length || AudioMeters.sameSelection(reported, this.startedFor);
    const slot = (barsW - pad) / count;
    for (let c = 0; c < count; c++) {
      const audible = carried.includes(c + 1);
      const x = pad + c * slot;
      const w = slot * 0.62;
      g.fillStyle = audible ? 'rgba(200,241,105,.16)' : 'rgba(255,255,255,.07)';
      g.fillRect(x, pad, w, barHeight);

      g.font = '11px system-ui,sans-serif';
      g.textAlign = 'left';
      g.fillStyle = audible ? '#C8F169' : 'rgba(255,255,255,.55)';
      g.fillText(`ch${c + 1}`, x, H - pad - 4);

      // Which decoded channel carries this source channel. In this mode the
      // bar array is already indexed by absolute channel, so no lookup is
      // needed; a channel whose pair has not connected yet stays unmeasured.
      const from = !onAir
        ? -1
        : this.perPairMode
          ? viz.channels[c]
            ? c
            : -1
          : peaks.length
            ? c
            : carried.indexOf(c + 1);
      if (from < 0) {
        this.levelsDb[c] = -120;
        this.sourceHold[c] = { peak: 0, hold: 0 };
        continue;
      }

      const target = peaks.length ? peaks[c] : this.decodedDb(viz, from);
      // Seeded with the target rather than silence, so opening a preview shows
      // the levels instead of sweeping up to them.
      const db = advanceLevelDb(this.levelsDb[c] ?? target, target, dt);
      this.levelsDb[c] = db;
      const v = AudioMeters.norm(db);
      this.sourceHold[c] ??= { peak: 0, hold: 0 };
      AudioMeters.advance(this.sourceHold[c], v, dt);

      const lit = Math.round(barHeight * v);
      g.fillStyle = db > HOT_DBFS ? '#F05012' : '#C8F169';
      g.fillRect(x, pad + barHeight - lit, w, lit);
      const peakY = pad + barHeight - Math.round(barHeight * this.sourceHold[c].peak);
      g.fillStyle = '#fff';
      g.fillRect(x, Math.max(pad, peakY - 2), w, 2);

      g.fillStyle = 'rgba(255,255,255,.45)';
      g.fillText(db <= -120 ? '-inf' : db.toFixed(1), x, H - pad + 8);
    }

    // Spectrum: log-ish frequency buckets so the low end isn't a sliver.
    viz.spectrum.getByteFrequencyData(viz.bins);
    const binCount = viz.bins.length;
    const colWidth = (W - specX - pad) / SPECTRUM_COLUMNS;
    for (let k = 0; k < SPECTRUM_COLUMNS; k++) {
      const lo = Math.floor((k / SPECTRUM_COLUMNS) ** 2 * binCount);
      let hi = Math.floor(((k + 1) / SPECTRUM_COLUMNS) ** 2 * binCount);
      if (hi <= lo) hi = lo + 1;
      let peak = 0;
      for (let b = lo; b < hi && b < binCount; b++) peak = Math.max(peak, viz.bins[b]);
      const h = Math.round(barHeight * (peak / 255));
      g.fillStyle = `rgba(200,241,105,${(0.35 + 0.65 * (peak / 255)).toFixed(3)})`;
      g.fillRect(specX + k * colWidth, H - pad - 28 - h, Math.max(1, colWidth - 1), h);
    }
    g.fillStyle = 'rgba(255,255,255,.45)';
    g.font = '11px system-ui,sans-serif';
    g.textAlign = 'left';
    g.fillText('spectrum of the audible pair', specX, H - pad + 4);
  }

  /** RMS of one decoded channel, in dBFS. Only reached without reported levels. */
  private decodedDb(viz: Visualisation, c: number): number {
    const ch = viz.channels[c];
    if (!ch) return -120;
    ch.analyser.getFloatTimeDomainData(ch.samples);
    let sum = 0;
    for (const s of ch.samples) sum += s * s;
    const rms = Math.sqrt(sum / ch.samples.length);
    return rms > 0 ? 20 * Math.log10(rms) : -120;
  }
}
