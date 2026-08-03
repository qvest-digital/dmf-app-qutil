import { vi } from 'vitest';
import { PlayerRegistry } from './player-registry';

type Handler = (event: unknown, data: unknown) => void;

/**
 * The instances the module under test built, newest last. A recovery that
 * replaces the instance is only visible as a second entry here.
 */
const built: FakeHls[] = [];

class FakeHls {
  static isSupported = () => true;
  static Events = { MANIFEST_PARSED: 'manifestParsed', ERROR: 'hlsError' };
  static ErrorTypes = {
    MEDIA_ERROR: 'mediaError',
    NETWORK_ERROR: 'networkError',
    MUX_ERROR: 'muxError',
  };

  readonly handlers = new Map<string, Handler>();
  readonly sources: string[] = [];
  startLoadCount = 0;
  recoverCount = 0;
  destroyed = false;

  constructor() {
    built.push(this);
  }

  loadSource(src: string): void {
    this.sources.push(src);
  }
  attachMedia(): void {}
  on(event: string, handler: Handler): void {
    this.handlers.set(event, handler);
  }
  startLoad(): void {
    this.startLoadCount++;
  }
  recoverMediaError(): void {
    this.recoverCount++;
  }
  destroy(): void {
    this.destroyed = true;
  }

  raise(type: string, fatal = true): void {
    this.handlers.get(FakeHls.Events.ERROR)?.(null, { type, fatal });
  }
}

vi.mock('hls.js', () => ({ default: FakeHls }));

const { hlsPlay, hlsUrl } = await import('./hls-player');

function videoStub(): HTMLVideoElement {
  return {
    srcObject: null,
    play: () => Promise.resolve(),
    canPlayType: () => '',
    removeAttribute: () => undefined,
    load: () => undefined,
    addEventListener: () => undefined,
  } as unknown as HTMLVideoElement;
}

describe('hlsPlay fatal error recovery', () => {
  let registry: PlayerRegistry;

  beforeEach(() => {
    built.length = 0;
    registry = new PlayerRegistry();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves a non-fatal error to hls.js', () => {
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR, false);

    expect(built[0].recoverCount).toBe(0);
    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    expect(built).toHaveLength(1);
  });

  // Reloading the source is what left a tile black while mediamtx opened a new
  // HLS session per attempt: the playlist is re-fetched, the MediaSource is not
  // reset. The media path has its own reset, and that is what has to run.
  it('resets the MediaSource on a fatal media error instead of reloading', () => {
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);

    expect(built[0].recoverCount).toBe(1);
    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    expect(built[0].destroyed).toBe(false);
  });

  it('does not reset again inside the retry window', () => {
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry, retryMs: 5000 });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);
    vi.advanceTimersByTime(1000);
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);

    expect(built[0].recoverCount).toBe(1);

    vi.advanceTimersByTime(5000);
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);
    expect(built[0].recoverCount).toBe(2);
  });

  // Paths are created on demand, so a player that starts before its path is
  // serving is the normal case: the manifest 404s, hls.js exhausts its retries,
  // and only loading the source again brings the element back. startLoad does
  // not, because it takes effect only once a manifest has been parsed -- which
  // is the whole failure being recovered from.
  it('loads the source again on a fatal network error, after a delay', () => {
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry, retryMs: 5000 });
    built[0].raise(FakeHls.ErrorTypes.NETWORK_ERROR);

    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    vi.advanceTimersByTime(5000);
    expect(built[0].sources).toEqual([
      '/hls/preview-a/index.m3u8',
      '/hls/preview-a/index.m3u8',
    ]);
    expect(built[0].startLoadCount).toBe(0);
    expect(built).toHaveLength(1);
  });

  // The path appearing late is what the retry exists for, so recovery has to
  // keep working across repeated failures rather than give up after one.
  it('keeps re-requesting a manifest that is not served yet', () => {
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry, retryMs: 5000 });
    for (let i = 0; i < 3; i++) {
      built[0].raise(FakeHls.ErrorTypes.NETWORK_ERROR);
      vi.advanceTimersByTime(5000);
    }
    expect(built[0].sources).toHaveLength(4);
  });

  it('replaces the instance when the error type cannot be recovered', () => {
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry, retryMs: 5000 });
    built[0].raise(FakeHls.ErrorTypes.MUX_ERROR);

    expect(built[0].destroyed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(built).toHaveLength(2);
    expect(built[1].sources).toEqual(['/hls/preview-a/index.m3u8']);
  });

  // A hidden tab tears every player down. A recovery already scheduled must not
  // bring one back, or the tab decodes while it is not on screen.
  it('abandons a scheduled recovery once stopped', () => {
    const handle = hlsPlay(hlsUrl('preview-a'), videoStub(), { registry, retryMs: 5000 });
    built[0].raise(FakeHls.ErrorTypes.NETWORK_ERROR);
    handle.stop();
    vi.advanceTimersByTime(5000);

    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    expect(built[0].destroyed).toBe(true);
    expect(built).toHaveLength(1);
    expect(registry.counts().hls).toBe(0);
  });

  it('reports a fatal error once per occurrence', () => {
    let fatals = 0;
    hlsPlay(hlsUrl('preview-a'), videoStub(), { registry, onFatal: () => fatals++ });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR, false);
    expect(fatals).toBe(0);
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);
    expect(fatals).toBe(1);
  });
});
