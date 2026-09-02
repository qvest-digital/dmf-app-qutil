import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AudioMeters } from './audio-meters';

/**
 * Where a level lands on the strip, and which channels carry one at all.
 *
 * The media server publishes the selected pair and measures nothing else, so
 * the graph holds two channels however wide the flow is. Metering them at bar
 * positions one and two puts the levels of source channels three and four
 * under labels reading ch1 and ch2, and capping the strip leaves the upper
 * channels of a wide flow with no bar to land on.
 */

interface Drawn {
  text: string;
  x: number;
}

class FakeNode {
  constructor(readonly name: string) {}
  connect(): void {}
  disconnect(): void {}
}

/** Each analyser reports a distinct level, so a bar's source is identifiable. */
class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  readonly frequencyBinCount = 512;
  constructor(
    name: string,
    private readonly amplitude: number,
  ) {
    super(name);
  }
  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(this.amplitude);
  }
  getByteFrequencyData(): void {}
}

class FakeAudioContext {
  readonly destination = { name: 'destination' };
  readonly state = 'running';
  private analysers = 0;

  resume(): Promise<void> {
    return Promise.resolve();
  }
  createMediaStreamSource(): FakeNode {
    return new FakeNode('stream');
  }
  createMediaElementSource(): FakeNode {
    return new FakeNode('element');
  }
  createChannelSplitter(): FakeNode {
    return new FakeNode('splitter');
  }
  createGain(): FakeNode {
    return Object.assign(new FakeNode('gain'), { gain: { value: 1 } });
  }
  createAnalyser(): FakeAnalyser {
    // 0.5 then 0.25, so the two metered bars read -6 dBFS and -12 dBFS.
    const amplitude = this.analysers++ === 0 ? 0.5 : 0.25;
    return new FakeAnalyser('analyser', amplitude);
  }
}

describe('AudioMeters strip', () => {
  let fixture: ComponentFixture<AudioMeters>;
  let meters: AudioMeters;
  let element: HTMLVideoElement;
  let drawn: Drawn[];
  const realAudioContext = (globalThis as unknown as { AudioContext: unknown }).AudioContext;
  const realRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    // Returning without invoking leaves exactly the one frame start() draws.
    globalThis.requestAnimationFrame = (() => 1) as unknown as typeof requestAnimationFrame;

    drawn = [];
    const context = {
      clearRect: () => {},
      fillRect: () => {},
      fillText: (text: string, x: number) => drawn.push({ text, x }),
      set fillStyle(_v: string) {},
      set font(_v: string) {},
      set textAlign(_v: string) {},
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
      context as unknown as CanvasRenderingContext2D,
    );

    TestBed.configureTestingModule({ imports: [AudioMeters] });
    fixture = TestBed.createComponent(AudioMeters);
    fixture.detectChanges();
    meters = fixture.componentInstance;
    element = document.createElement('video');
  });

  afterEach(() => {
    fixture.destroy();
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = realAudioContext;
    globalThis.requestAnimationFrame = realRaf;
    vi.restoreAllMocks();
  });

  const labels = () => drawn.filter((d) => d.text.startsWith('ch')).map((d) => d.text);
  const levels = () => drawn.filter((d) => /^(-?\d+\.\d|-inf)$/.test(d.text));
  const xOf = (label: string) => drawn.find((d) => d.text === label)!.x;

  const open = (channels: number, selected: number[]) => {
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    meters.start({} as MediaStream, channels, element);
  };

  it('draws one bar per source channel of a wide flow', () => {
    open(12, [1, 2]);

    expect(labels()).toEqual([
      'ch1',
      'ch2',
      'ch3',
      'ch4',
      'ch5',
      'ch6',
      'ch7',
      'ch8',
      'ch9',
      'ch10',
      'ch11',
      'ch12',
    ]);
  });

  /** The regression: the pair was metered at positions one and two regardless. */
  it('meters the published pair at the positions it was selected from', () => {
    open(12, [3, 4]);

    expect(levels().map((d) => d.x)).toEqual([xOf('ch3'), xOf('ch4')]);
    expect(levels().map((d) => d.text)).toEqual(['-6.0', '-12.0']);
  });

  it('meters the last pair of a wide flow, which no cap leaves room for', () => {
    open(12, [11, 12]);

    expect(levels().map((d) => d.x)).toEqual([xOf('ch11'), xOf('ch12')]);
  });

  it('leaves an unmeasured channel without a level rather than showing silence', () => {
    open(12, [3, 4]);

    // Two of twelve carry a number; the rest would read as silence if drawn.
    expect(levels()).toHaveLength(2);
  });

  /**
   * The status does not report a selection until it answers, and a path holds
   * the flow's first channels until it is configured with a pair. Metering
   * only what `selected` names leaves a freshly opened card with no level on
   * any bar while the sound is already playing.
   */
  it('meters the first channels while the selection is still unreported', () => {
    open(12, []);

    expect(levels().map((d) => d.x)).toEqual([xOf('ch1'), xOf('ch2')]);
    expect(levels().map((d) => d.text)).toEqual(['-6.0', '-12.0']);
  });

  it('meters every channel when a reporter supplies levels for all of them', () => {
    fixture.componentRef.setInput(
      'sourcePeaks',
      Array.from({ length: 12 }, (_, i) => -i),
    );
    open(12, [1, 2]);

    expect(levels()).toHaveLength(12);
  });
});
