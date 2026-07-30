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
 * Level meters and a spectrum for an audio preview, drawn from the stream the
 * browser has already decoded — nothing extra is computed or shipped from the
 * cluster.
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

  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');

  /**
   * Created once and reused: createMediaElementSource throws on a second call for
   * the same element, so a re-opened preview must not build a new one.
   */
  private context: AudioContext | null = null;
  private elementSource: MediaElementAudioSourceNode | null = null;

  private viz: Visualisation | null = null;
  private frame = 0;

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
    if (!wasRunning) return;
    const canvas = this.canvasRef().nativeElement;
    canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** -60..0 dBFS -> 0..1 */
  private static norm(db: number): number {
    return Math.max(0, Math.min(1, (db + 60) / 60));
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

    const pad = 18;
    const barsW = Math.round(W * 0.34);
    const specX = barsW + pad * 2;
    const barHeight = H - pad * 2 - 16;

    // Level bars: RMS with a decaying peak-hold per channel.
    const count = viz.channels.length;
    const slot = (barsW - pad) / count;
    for (let c = 0; c < count; c++) {
      const ch = viz.channels[c];
      ch.analyser.getFloatTimeDomainData(ch.samples);
      let sum = 0;
      for (const s of ch.samples) sum += s * s;
      const rms = Math.sqrt(sum / ch.samples.length);
      const db = rms > 0 ? 20 * Math.log10(rms) : -120;
      const v = AudioMeters.norm(db);
      if (v >= ch.peak) {
        ch.peak = v;
        ch.hold = performance.now();
      } else if (performance.now() - ch.hold > PEAK_HOLD_MS) {
        ch.peak = Math.max(v, ch.peak - PEAK_DECAY);
      }

      const x = pad + c * slot;
      const w = slot * 0.62;
      g.fillStyle = 'rgba(255,255,255,.07)';
      g.fillRect(x, pad, w, barHeight);
      const lit = Math.round(barHeight * v);
      g.fillStyle = db > HOT_DBFS ? '#F05012' : '#C8F169';
      g.fillRect(x, pad + barHeight - lit, w, lit);
      const peakY = pad + barHeight - Math.round(barHeight * ch.peak);
      g.fillStyle = '#fff';
      g.fillRect(x, Math.max(pad, peakY - 2), w, 2);
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.font = '11px system-ui,sans-serif';
      g.textAlign = 'left';
      g.fillText(`ch${c + 1}  ${db <= -120 ? '-inf' : db.toFixed(1)} dB`, x, H - pad + 4);
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
      g.fillRect(specX + k * colWidth, H - pad - 16 - h, Math.max(1, colWidth - 1), h);
    }
    g.fillStyle = 'rgba(255,255,255,.45)';
    g.font = '11px system-ui,sans-serif';
    g.textAlign = 'left';
    g.fillText('spectrum', specX, H - pad + 4);
  }
}
