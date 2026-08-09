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
  src: AudioNode;
  channels: ChannelMeter[];
  spectrum: AnalyserNode;
  bins: Uint8Array<ArrayBuffer>;
}

/** Peak-hold dwell before the marker starts sliding back down. */
const PEAK_HOLD_MS = 900;
/** How fast it slides, per frame. */
const PEAK_DECAY = 0.012;
/** Above this the bar turns orange — the usual "too hot" cue. */
const HOT_DBFS = -6;
const MAX_CHANNELS = 8;
const SPECTRUM_COLUMNS = 64;
/**
 * How fast a bar falls when the reported level drops, in dB per second. Matches
 * the audio preview's own envelope, so carrying the level between polls follows
 * the curve the reported value is already on rather than inventing one.
 */
const LEVEL_DECAY_DB_PER_SEC = 30;

/**
 * One step of meter ballistics: rise to the target at once, fall at a fixed
 * rate. Reported levels arrive a few times a second and the canvas redraws
 * sixty; without this the bars would sit still and then jump, which reads as
 * lag even when the numbers are current.
 */
export function advanceLevelDb(current: number, target: number, dtMs: number): number {
  if (target >= current) return target;
  return Math.max(target, current - (LEVEL_DECAY_DB_PER_SEC * Math.max(dtMs, 0)) / 1000);
}

/** Past this many bars the strip needs the wider half of the canvas. */
const WIDE_STRIP_CHANNELS = 8;

/**
 * Level meters and a spectrum for an audio preview.
 *
 * The bars are the flow's channels, all of them, from the levels the
 * audio-preview reports — only two are ever delivered to the browser, so
 * measuring the decoded stream would meter the pair being listened to and say
 * nothing about the rest of a 12-channel flow. The spectrum stays client-side
 * off the decoded stream, which is the part that is actually audible.
 *
 * Those levels arrive a few times a second and are already an envelope, so the
 * bars are driven by ballistics at frame rate rather than set to whatever the
 * last poll said: the movement between polls is the fall the reported level is
 * on, not an invented interpolation.
 *
 * With no reported levels (an audio-preview that predates them) the bars fall
 * back to measuring the decoded stream, which is right for the stereo flows
 * that case can still play.
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

  private viz: Visualisation | null = null;
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
      // sound — routing to destination as well would play it twice. HLS/MSE: the
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

    const count = Math.min(Math.max(channels || 2, 1), MAX_CHANNELS);
    const splitter = ctx.createChannelSplitter(count);
    src.connect(splitter);

    const meters: ChannelMeter[] = [];
    for (let i = 0; i < count; i++) {
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
    if (!stream) src.connect(ctx.destination);

    this.viz = {
      src,
      channels: meters,
      spectrum,
      bins: new Uint8Array(spectrum.frequencyBinCount),
    };
    this.draw();
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
      try {
        // The element source is permanent — only detach it from the graph.
        this.viz.src.disconnect();
      } catch {
        // Already detached.
      }
      this.viz = null;
    }
    this.sourceHold = [];
    this.levelsDb = [];
    this.lastFrameAt = 0;
    if (!wasRunning) return;
    const canvas = this.canvasRef().nativeElement;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** -60..0 dBFS -> 0..1 */
  private static norm(db: number): number {
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  /** One peak-hold step against a level that may not have moved since the last frame. */
  private static advance(state: HoldState, v: number): void {
    if (v >= state.peak) {
      state.peak = v;
      state.hold = performance.now();
    } else if (performance.now() - state.hold > PEAK_HOLD_MS) {
      state.peak = Math.max(v, state.peak - PEAK_DECAY);
    }
  }

  private draw(): void {
    this.frame = requestAnimationFrame(() => this.draw());
    const viz = this.viz;
    if (!viz) return;

    const canvas = this.canvasRef().nativeElement;
    const g = canvas.getContext('2d');
    if (!g) return;
    const W = canvas.width;
    const H = canvas.height;
    g.clearRect(0, 0, W, H);

    const peaks = this.sourcePeaks();
    const count = peaks.length || viz.channels.length;
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

    const selected = this.selected();
    const slot = (barsW - pad) / count;
    for (let c = 0; c < count; c++) {
      const target = peaks.length ? peaks[c] : this.decodedDb(viz, c);
      const db = advanceLevelDb(this.levelsDb[c] ?? -120, target, dt);
      this.levelsDb[c] = db;
      const v = AudioMeters.norm(db);
      this.sourceHold[c] ??= { peak: 0, hold: 0 };
      AudioMeters.advance(this.sourceHold[c], v);

      const audible = selected.includes(c + 1);
      const x = pad + c * slot;
      const w = slot * 0.62;
      g.fillStyle = audible ? 'rgba(200,241,105,.16)' : 'rgba(255,255,255,.07)';
      g.fillRect(x, pad, w, barHeight);
      const lit = Math.round(barHeight * v);
      g.fillStyle = db > HOT_DBFS ? '#F05012' : '#C8F169';
      g.fillRect(x, pad + barHeight - lit, w, lit);
      const peakY = pad + barHeight - Math.round(barHeight * this.sourceHold[c].peak);
      g.fillStyle = '#fff';
      g.fillRect(x, Math.max(pad, peakY - 2), w, 2);

      g.font = '11px system-ui,sans-serif';
      g.textAlign = 'left';
      g.fillStyle = audible ? '#C8F169' : 'rgba(255,255,255,.55)';
      g.fillText(`ch${c + 1}`, x, H - pad - 4);
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
