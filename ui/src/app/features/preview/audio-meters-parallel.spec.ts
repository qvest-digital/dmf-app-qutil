import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AudioMeters, PairStream } from './audio-meters';

/**
 * Every pair of a wide flow connects at once, so every bar has to keep
 * reading its own stream regardless of which pair is currently heard; only
 * the spectrum, and the "heard" marker on the bars, follow the selection.
 */

interface Drawn {
  text: string;
  x: number;
}

interface Link {
  from: string;
  to: string;
}

class FakeNode {
  constructor(
    readonly name: string,
    private readonly links: Link[],
  ) {}
  connect(target: FakeNode | { name: string }): void {
    this.links.push({ from: this.name, to: target.name });
  }
  disconnect(target?: FakeNode | { name: string }): void {
    for (let i = this.links.length - 1; i >= 0; i--) {
      const link = this.links[i];
      if (link.from !== this.name) continue;
      if (target && link.to !== target.name) continue;
      this.links.splice(i, 1);
    }
  }
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  readonly frequencyBinCount = 512;
  constructor(
    name: string,
    links: Link[],
    private readonly amplitude: number,
  ) {
    super(name, links);
  }
  getFloatTimeDomainData(samples: Float32Array): void {
    samples.fill(this.amplitude);
  }
  getByteFrequencyData(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  readonly links: Link[] = [];
  readonly destination = { name: 'destination' };
  readonly state = 'running';
  readonly analysersCreated: FakeAnalyser[] = [];
  private streamSources = 0;

  constructor() {
    FakeAudioContext.last = this;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
  createMediaStreamSource(): FakeNode {
    return new FakeNode(`stream${this.streamSources++}`, this.links);
  }
  createChannelSplitter(): FakeNode {
    return new FakeNode('splitter', this.links);
  }
  createAnalyser(): FakeAnalyser {
    const i = this.analysersCreated.length;
    // Halves each time: -6.0, -12.0, -18.1, -24.1, -30.1, -36.1 dBFS.
    const amplitude = 0.5 / 2 ** i;
    const analyser = new FakeAnalyser(`analyser${i}`, this.links, amplitude);
    this.analysersCreated.push(analyser);
    return analyser;
  }
}

describe('AudioMeters startMulti', () => {
  let fixture: ComponentFixture<AudioMeters>;
  let meters: AudioMeters;
  let drawn: Drawn[];
  const realAudioContext = (globalThis as unknown as { AudioContext: unknown }).AudioContext;
  const realRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    FakeAudioContext.last = null;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
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
  const spectrumNode = () => FakeAudioContext.last!.analysersCreated.at(-1)!;

  const sources: PairStream[] = [
    { pair: [1, 2], stream: {} as MediaStream },
    { pair: [3, 4], stream: {} as MediaStream },
    { pair: [5, 6], stream: {} as MediaStream },
  ];

  const open = (selected: number[]) => {
    fixture.componentRef.setInput('selected', selected);
    fixture.detectChanges();
    meters.startMulti(sources, 6);
  };

  it('meters every connected pair regardless of which is selected', () => {
    open([1, 2]);

    expect(labels()).toEqual(['ch1', 'ch2', 'ch3', 'ch4', 'ch5', 'ch6']);
    expect(levels().map((d) => d.text)).toEqual([
      '-6.0',
      '-12.0',
      '-18.1',
      '-24.1',
      '-30.1',
      '-36.1',
    ]);
  });

  it('keeps every bar measured across a pair switch, with no gap', () => {
    open([1, 2]);
    expect(levels()).toHaveLength(6);

    fixture.componentRef.setInput('selected', [5, 6]);
    fixture.detectChanges();
    drawn = [];
    (meters as unknown as { draw(): void }).draw();

    expect(levels()).toHaveLength(6);
  });

  it('leaves a channel whose pair has not connected yet without a level', () => {
    fixture.componentRef.setInput('selected', [1, 2]);
    fixture.detectChanges();
    meters.startMulti(sources.slice(0, 2), 6);

    expect(levels().map((d) => d.x)).toEqual([xOf('ch1'), xOf('ch2'), xOf('ch3'), xOf('ch4')]);
  });

  it('feeds the spectrum from the selected pair, not the others', () => {
    open([3, 4]);

    const links = FakeAudioContext.last!.links;
    expect(links.some((l) => l.from === 'stream1' && l.to === spectrumNode().name)).toBe(true);
    expect(links.some((l) => l.from === 'stream0' && l.to === spectrumNode().name)).toBe(false);
  });

  it('moves the spectrum to the newly selected pair without dropping its bars', () => {
    open([1, 2]);
    fixture.componentRef.setInput('selected', [5, 6]);
    fixture.detectChanges();
    drawn = [];
    (meters as unknown as { draw(): void }).draw();

    const links = FakeAudioContext.last!.links;
    expect(links.some((l) => l.from === 'stream0' && l.to === spectrumNode().name)).toBe(false);
    expect(links.some((l) => l.from === 'stream2' && l.to === spectrumNode().name)).toBe(true);
    // stream0's splitter link feeds ch1/ch2's bars and must survive the move.
    expect(links.some((l) => l.from === 'stream0' && l.to === 'splitter')).toBe(true);
  });
});
