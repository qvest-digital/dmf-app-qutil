import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { AudioSnapshot, GrainMeta, GrainRing, OperatorFlow } from '../../core/api/models';
import { decodeV210 } from '../../shared/v210';

interface Entry {
  /** 1-based, as the button reads. */
  n: number;
  index: number;
  /** Discrete flows carry per-grain metadata; audio windows do not. */
  meta?: GrainMeta;
  count?: number;
}

/**
 * A snapshot of what is in a flow's ring, one button per entry.
 *
 * The ring is a transport buffer rather than a history: this domain holds five
 * video grains and about 400 ms of audio, so an index is overwritten long
 * before anyone clicks the button naming it. Capture copies the whole ring at
 * once and the row then browses that copy, which is why there is a capture
 * step at all rather than a row that is simply always there.
 */
@Component({
  selector: 'mv-grain-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [],
  templateUrl: './grain-strip.html',
})
export class GrainStrip {
  private readonly api = inject(MetricsApi);

  readonly flow = input.required<OperatorFlow>();

  private readonly canvasRef = viewChild<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly waveRef = viewChild<ElementRef<HTMLCanvasElement>>('wave');

  protected readonly ring = signal<GrainRing | null>(null);
  protected readonly entries = signal<Entry[]>([]);
  protected readonly selected = signal<number | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly takenAt = signal<string | null>(null);

  protected readonly grain = signal<GrainMeta | null>(null);
  protected readonly audio = signal<AudioSnapshot | null>(null);
  protected readonly hex = signal<string | null>(null);

  protected readonly isAudio = computed(() => this.flow().format === 'audio');
  protected readonly isVideo = computed(() => this.flow().format === 'video');

  /** Capture the ring, then draw the row from what came back. */
  protected capture(): void {
    this.busy.set(true);
    this.error.set(null);
    this.reset();
    this.api.captureRing(this.flow().id).subscribe({
      next: (cap) => {
        this.ring.set(cap.info);
        this.takenAt.set(cap.taken);
        if (cap.grains?.length) {
          this.entries.set(cap.grains.map((meta, i) => ({ n: i + 1, index: meta.index, meta })));
        } else {
          const windows = cap.info?.windows ?? [];
          this.entries.set(windows.map((w, i) => ({ n: i + 1, index: w.index, count: w.count })));
        }
        this.busy.set(false);
        if (this.entries().length) this.show(this.entries()[0]);
      },
      error: (e) => {
        this.error.set(e?.error?.error ?? 'capture failed');
        this.busy.set(false);
      },
    });
  }

  protected show(entry: Entry): void {
    this.selected.set(entry.n);
    this.error.set(null);
    if (this.isAudio()) return this.showAudio(entry);
    this.showGrain(entry);
  }

  private showGrain(entry: Entry): void {
    const meta = entry.meta ?? null;
    this.grain.set(meta);
    this.audio.set(null);
    this.hex.set(null);
    this.api.grainPayload(this.flow().id, entry.index).subscribe({
      next: (buf) => {
        if (this.isVideo() && meta?.width && meta.height) {
          this.paint(buf, meta);
        } else {
          // Data flows decode to neither a picture nor a sound. The parsed
          // RFC 8331 view is the ANC card's job and only covers the newest
          // grain, so a captured one shows its bytes.
          this.hex.set(hexdump(buf, 512));
        }
      },
      error: (e) => this.error.set(e?.error?.error ?? 'grain not available'),
    });
  }

  private paint(buf: ArrayBuffer, meta: GrainMeta): void {
    const canvas = this.canvasRef()?.nativeElement;
    if (!canvas) return;
    canvas.width = meta.width!;
    canvas.height = meta.height!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      const frame = decodeV210(buf, meta.width!, meta.height!, meta.stride);
      const img = ctx.createImageData(frame.width, frame.height);
      img.data.set(frame.data);
      ctx.putImageData(img, 0, 0);
    } catch {
      this.error.set('could not unpack this grain as v210');
    }
  }

  private showAudio(entry: Entry): void {
    this.grain.set(null);
    this.hex.set(null);
    this.api.audioSnapshot(this.flow().id, entry.index, entry.count ?? 0).subscribe({
      next: (snap) => {
        this.audio.set(snap);
        this.paintWave(snap);
      },
      error: (e) => this.error.set(e?.error?.error ?? 'window not available'),
    });
  }

  /** One row per channel, so a silent or clipped channel is visible as such. */
  private paintWave(snap: AudioSnapshot): void {
    const canvas = this.waveRef()?.nativeElement;
    if (!canvas || !snap.channels.length) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = (canvas.width = canvas.clientWidth || 600);
    const rowH = 54;
    const h = (canvas.height = rowH * snap.channels.length);
    ctx.clearRect(0, 0, w, h);
    snap.channels.forEach((ch, i) => {
      const mid = i * rowH + rowH / 2;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(w, mid);
      ctx.stroke();
      ctx.strokeStyle = '#4ea1ff';
      ctx.beginPath();
      ch.samples.forEach((v, s) => {
        const x = (s / Math.max(1, ch.samples.length - 1)) * w;
        const y = mid - v * (rowH / 2 - 4);
        s === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  private reset(): void {
    this.entries.set([]);
    this.selected.set(null);
    this.grain.set(null);
    this.audio.set(null);
    this.hex.set(null);
  }
}

/** Offset-prefixed hex, truncated: a data grain is kilobytes and the point is
 *  the shape of the first packets, not the whole payload. */
function hexdump(buf: ArrayBuffer, limit: number): string {
  const bytes = new Uint8Array(buf.slice(0, limit));
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = Array.from(bytes.slice(i, i + 16));
    lines.push(
      i.toString(16).padStart(6, '0') +
        '  ' +
        chunk.map((b) => b.toString(16).padStart(2, '0')).join(' '),
    );
  }
  if (buf.byteLength > limit) lines.push(`... ${buf.byteLength - limit} more bytes`);
  return lines.join('\n');
}
