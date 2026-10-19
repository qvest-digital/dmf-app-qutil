import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OperatorFlow } from '../../core/api/models';
import { GrainStrip } from './grain-strip';

function flow(id: string, format: string): OperatorFlow {
  return {
    id,
    label: id,
    description: null,
    format,
    mediaType: null,
    resolution: null,
    rate: null,
    channels: null,
    colorspace: null,
    grouphint: null,
    locations: [],
    detail: null,
  } as unknown as OperatorFlow;
}

const VIDEO = flow('d4d00000-0000-0000-0000-000000000001', 'video');
const AUDIO = flow('a0d10000-0000-0000-0000-000000000001', 'audio');

describe('GrainStrip', () => {
  let fixture: ComponentFixture<GrainStrip>;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    fixture = TestBed.createComponent(GrainStrip);
    http = TestBed.inject(HttpTestingController);
  });

  async function render(f: OperatorFlow) {
    fixture.componentRef.setInput('flow', f);
    await fixture.whenStable();
    return fixture.nativeElement as HTMLElement;
  }

  const videoCanvas = (el: HTMLElement) => el.querySelector('canvas.grain-canvas')!;

  it('keeps the frame canvas off until a grain has been read', async () => {
    const el = await render(VIDEO);
    expect(videoCanvas(el).classList.contains('off')).toBe(true);
  });

  /**
   * The frame canvas is toggled by class rather than by [hidden]: the
   * stylesheet sets display on .grain-canvas, which outranks the user agent's
   * rule for the attribute, so [hidden] left a black frame sitting under the
   * audio waveform.
   */
  it('never shows the frame canvas for an audio flow', async () => {
    const el = await render(AUDIO);
    fixture.componentInstance['capture']();

    http.expectOne(`/api/grains/${AUDIO.id}`).flush({
      taken: '2026-01-01T00:00:00Z',
      flow: AUDIO.id,
      info: {
        flow: AUDIO.id,
        format: 'audio',
        grainRate: { num: 48000, den: 1 },
        headIndex: 1000,
        firstIndex: 800,
        channelCount: 2,
        bufferLength: 200,
        sampleRate: 48000,
        windows: [{ index: 800, count: 100 }],
      },
    });
    http.expectOne(`/api/samples/${AUDIO.id}/800/100`).flush({
      flow: AUDIO.id,
      index: 800,
      count: 100,
      sampleRate: 48000,
      channels: [{ channel: 0, peak: 0.5, rms: 0.35, min: -0.5, samples: [0, 0.5, -0.5] }],
    });
    await fixture.whenStable();

    expect(videoCanvas(el).classList.contains('off')).toBe(true);
  });

  it('numbers a button per captured grain', async () => {
    const el = await render(VIDEO);
    fixture.componentInstance['capture']();

    const grains = [1, 2, 3].map((i) => ({
      flow: VIDEO.id,
      index: 500 + i,
      flags: 0,
      grainSize: 10,
      totalSlices: 720,
      validSlices: 720,
      complete: true,
      invalid: false,
      bytes: 10,
      width: 1296,
      height: 720,
      mediaType: 'video/v210',
      stride: 3456,
    }));
    http.expectOne(`/api/grains/${VIDEO.id}`).flush({
      taken: '2026-01-01T00:00:00Z',
      flow: VIDEO.id,
      info: {
        flow: VIDEO.id,
        format: 'video',
        grainRate: { num: 30000, den: 1001 },
        headIndex: 503,
        firstIndex: 501,
        grainCount: 3,
      },
      grains,
    });
    // The first entry is shown on capture, which fetches its payload.
    http.expectOne(`/api/grain/${VIDEO.id}/501/raw`).flush(new ArrayBuffer(8));
    await fixture.whenStable();

    const labels = [...el.querySelectorAll('.grain-btn')].map((b) => b.textContent!.trim());
    expect(labels).toEqual(['1', '2', '3']);
  });

  /**
   * The wave canvas is painted from the callback that sets audio(), before
   * the view has rendered anything that depends on it. A canvas inside the
   * audio block was not in the DOM at that moment, so the first window
   * showed its numbers and an empty frame; only the next click drew.
   */
  it('draws the waveform for the first window shown', async () => {
    const strokes: string[] = [];
    const ctx = {
      clearRect: () => {},
      beginPath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => strokes.push('stroke'),
      strokeStyle: '',
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () => ctx as unknown as CanvasRenderingContext2D,
    );
    const el = await render(AUDIO);
    fixture.componentInstance['capture']();

    http.expectOne(`/api/grains/${AUDIO.id}`).flush({
      taken: '2026-01-01T00:00:00Z',
      flow: AUDIO.id,
      info: {
        flow: AUDIO.id,
        format: 'audio',
        grainRate: { num: 48000, den: 1 },
        headIndex: 1000,
        firstIndex: 800,
        channelCount: 2,
        bufferLength: 200,
        sampleRate: 48000,
        windows: [{ index: 800, count: 100 }],
      },
    });
    http.expectOne(`/api/samples/${AUDIO.id}/800/100`).flush({
      flow: AUDIO.id,
      index: 800,
      count: 100,
      sampleRate: 48000,
      channels: [
        { channel: 0, peak: 0.5, rms: 0.35, min: -0.5, samples: [0, 0.5, -0.5] },
        { channel: 1, peak: 0.1, rms: 0.05, min: -0.1, samples: [0, 0.1, -0.1] },
      ],
    });
    await fixture.whenStable();

    const wave = [...el.querySelectorAll('canvas')].find(
      (c) => !c.classList.contains('off'),
    ) as HTMLCanvasElement;
    // One row of 54px per channel, and at least the midline strokes.
    expect(wave.height).toBe(108);
    expect(strokes.length).toBeGreaterThan(0);
  });
});
