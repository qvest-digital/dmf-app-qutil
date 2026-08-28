import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { AudioMeters } from './audio-meters';

/**
 * Which node reaches the speakers, across a change of transport.
 *
 * createMediaElementSource takes an element's output away permanently. Before
 * a card could recover from HLS back to WHEP that never mattered, because a
 * card only ever went the other way. Now it can, and an element captured by
 * the HLS branch cannot make the sound again: the WHEP branch has to carry it
 * or the card plays silently for the rest of its life.
 */

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
  disconnect(): void {
    for (let i = this.links.length - 1; i >= 0; i--) {
      if (this.links[i].from === this.name) this.links.splice(i, 1);
    }
  }
}

class FakeGain extends FakeNode {
  readonly gain = { value: 1 };
}

class FakeAnalyser extends FakeNode {
  fftSize = 2048;
  smoothingTimeConstant = 0;
  readonly frequencyBinCount = 512;
  getFloatTimeDomainData(): void {}
  getByteFrequencyData(): void {}
}

class FakeAudioContext {
  static last: FakeAudioContext | null = null;
  readonly links: Link[] = [];
  readonly destination = { name: 'destination' };
  readonly state = 'running';
  gains: FakeGain[] = [];
  elementSources = 0;

  constructor() {
    FakeAudioContext.last = this;
  }

  resume(): Promise<void> {
    return Promise.resolve();
  }
  createMediaStreamSource(): FakeNode {
    return new FakeNode('stream', this.links);
  }
  createMediaElementSource(): FakeNode {
    this.elementSources++;
    // The real one throws on a second call for the same element, which is why
    // the component keeps the node rather than rebuilding it.
    if (this.elementSources > 1) throw new Error('element already captured');
    return new FakeNode('element', this.links);
  }
  createChannelSplitter(): FakeNode {
    return new FakeNode('splitter', this.links);
  }
  createAnalyser(): FakeAnalyser {
    return new FakeAnalyser('analyser', this.links);
  }
  createGain(): FakeGain {
    const gain = new FakeGain('gain', this.links);
    this.gains.push(gain);
    return gain;
  }
}

describe('AudioMeters output routing', () => {
  let fixture: ComponentFixture<AudioMeters>;
  let meters: AudioMeters;
  let element: HTMLVideoElement;
  const realAudioContext = (globalThis as unknown as { AudioContext: unknown }).AudioContext;
  const realRaf = globalThis.requestAnimationFrame;

  beforeEach(() => {
    FakeAudioContext.last = null;
    (globalThis as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
    globalThis.requestAnimationFrame = (() => 1) as unknown as typeof requestAnimationFrame;

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

  const reaching = (links: Link[]) =>
    links.filter((l) => l.to === 'destination').map((l) => l.from);

  it('routes the element to the speakers on HLS, where the graph is the only path', () => {
    meters.start(null, 2, element);

    expect(reaching(FakeAudioContext.last!.links)).toEqual(['element']);
  });

  it('leaves the element to make its own sound on WHEP', () => {
    meters.start({} as MediaStream, 2, element);

    // The element plays the MediaStream itself; connecting the tap to the
    // destination as well would play it twice.
    expect(reaching(FakeAudioContext.last!.links)).toEqual([]);
  });

  /** The regression: HLS, then back to WHEP on the same element. */
  it('carries the sound on the stream once HLS has captured the element', () => {
    meters.start(null, 2, element);
    meters.stop();
    meters.start({} as MediaStream, 2, element);

    expect(reaching(FakeAudioContext.last!.links)).toEqual(['gain']);
  });

  it('keeps the element volume governing the sound it no longer makes', () => {
    meters.start(null, 2, element);
    meters.stop();
    element.volume = 0.25;
    meters.start({} as MediaStream, 2, element);

    const gain = FakeAudioContext.last!.gains.at(-1)!;
    expect(gain.gain.value).toBeCloseTo(0.25, 6);

    element.muted = true;
    element.dispatchEvent(new Event('volumechange'));
    expect(gain.gain.value).toBe(0);
  });

  it('stops driving the gain from an element it has let go of', () => {
    meters.start(null, 2, element);
    meters.stop();
    meters.start({} as MediaStream, 2, element);
    const gain = FakeAudioContext.last!.gains.at(-1)!;
    meters.stop();

    element.volume = 0.5;
    element.dispatchEvent(new Event('volumechange'));

    expect(gain.gain.value).toBe(1);
    expect(reaching(FakeAudioContext.last!.links)).toEqual([]);
  });
});
