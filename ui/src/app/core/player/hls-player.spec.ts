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
  readonly config: Record<string, unknown>;
  startLoadCount = 0;
  recoverCount = 0;
  destroyed = false;
  liveSyncPosition = 120;
  latency = 3.5;

  constructor(config: Record<string, unknown> = {}) {
    this.config = config;
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

const { hlsPlay } = await import('./hls-player');

type VideoStub = HTMLVideoElement & { fire: (event: string) => void };

function videoStub(): VideoStub {
  const listeners = new Map<string, () => void>();
  return {
    srcObject: null,
    currentTime: 0,
    play: () => Promise.resolve(),
    canPlayType: () => '',
    removeAttribute: () => undefined,
    load: () => undefined,
    addEventListener: (event: string, handler: () => void) => listeners.set(event, handler),
    removeEventListener: (event: string) => listeners.delete(event),
    fire: (event: string) => listeners.get(event)?.(),
  } as unknown as VideoStub;
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

  // The media server publishes the low-latency variant. With this off, hls.js
  // ignores EXT-X-PART and syncs on whole segments, which costs the playlist
  // window and reports nothing: the server half reads as having made no
  // difference.
  it('enables low-latency mode so EXT-X-PART is used', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry });

    expect(built[0].config['lowLatencyMode']).toBe(true);
  });

  it('leaves a non-fatal error to hls.js', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR, false);

    expect(built[0].recoverCount).toBe(0);
    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    expect(built).toHaveLength(1);
  });

  // Reloading the source is what left a tile black while mediamtx opened a new
  // HLS session per attempt: the playlist is re-fetched, the MediaSource is not
  // reset. The media path has its own reset, and that is what has to run.
  it('resets the MediaSource on a fatal media error instead of reloading', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);

    expect(built[0].recoverCount).toBe(1);
    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    expect(built[0].destroyed).toBe(false);
  });

  it('does not reset again inside the retry window', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry, retryMs: 5000 });
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
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry, retryMs: 5000 });
    built[0].raise(FakeHls.ErrorTypes.NETWORK_ERROR);

    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8']);
    vi.advanceTimersByTime(5000);
    expect(built[0].sources).toEqual(['/hls/preview-a/index.m3u8', '/hls/preview-a/index.m3u8']);
    expect(built[0].startLoadCount).toBe(0);
    expect(built).toHaveLength(1);
  });

  // The path appearing late is what the retry exists for, so recovery has to
  // keep working across repeated failures rather than give up after one.
  it('keeps re-requesting a manifest that is not served yet', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry, retryMs: 5000 });
    for (let i = 0; i < 3; i++) {
      built[0].raise(FakeHls.ErrorTypes.NETWORK_ERROR);
      vi.advanceTimersByTime(5000);
    }
    expect(built[0].sources).toHaveLength(4);
  });

  it('replaces the instance when the error type cannot be recovered', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry, retryMs: 5000 });
    built[0].raise(FakeHls.ErrorTypes.MUX_ERROR);

    expect(built[0].destroyed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(built).toHaveLength(2);
    expect(built[1].sources).toEqual(['/hls/preview-a/index.m3u8']);
  });

  // A hidden tab tears every player down. A recovery already scheduled must not
  // bring one back, or the tab decodes while it is not on screen.
  it('abandons a scheduled recovery once stopped', () => {
    const handle = hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry, retryMs: 5000 });
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
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry, onFatal: () => fatals++ });
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR, false);
    expect(fatals).toBe(0);
    built[0].raise(FakeHls.ErrorTypes.MEDIA_ERROR);
    expect(fatals).toBe(1);
  });
});

/**
 * Catching up, which the preview card used to have switched off.
 *
 * It passed a null latency ceiling to leave the live edge to hls.js, and
 * hls.js on its own does nothing about latency below that ceiling. A card that
 * rebuffered once kept the delay it picked up for as long as it stayed open,
 * which on a wall watched for an afternoon is the whole complaint.
 */
describe('hlsPlay live latency', () => {
  let registry: PlayerRegistry;

  beforeEach(() => {
    built.length = 0;
    registry = new PlayerRegistry();
  });

  it('is allowed to play faster than real time to close a gap', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry });

    // Anything above 1 recovers latency without a seek, so the picture eases
    // back to live rather than jumping and rebuffering.
    expect(built[0].config['maxLiveSyncPlaybackRate']).toBeGreaterThan(1);
  });

  it('does not leave the latency ceiling switched off', () => {
    hlsPlay('/hls/preview-a/index.m3u8', videoStub(), { registry });

    // Absent means the hls.js default, which does seek forward. The
    // regression was passing null to disable it outright.
    expect(built[0].config['liveMaxLatencyDurationCount']).toBeUndefined();
  });

  /**
   * A minimized window or a hidden tab leaves the element behind by however
   * long it was away, and hls.js resumes from there. That gap is unbounded, so
   * it is the one the playback-rate catch-up cannot close.
   */
  it('resumes at the live edge rather than where it stopped', () => {
    const video = videoStub();
    hlsPlay('/hls/preview-a/index.m3u8', video, { registry });

    video.fire('play');

    expect(video.currentTime).toBe(120);
  });

  it('does not seek when hls.js has no live edge to give', () => {
    const video = videoStub();
    hlsPlay('/hls/preview-a/index.m3u8', video, { registry });
    built[0].liveSyncPosition = NaN;

    video.fire('play');

    expect(video.currentTime).toBe(0);
  });

  it('reports how far behind live it is, so the two transports compare', () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      hlsPlay('/hls/preview-a/index.m3u8', videoStub(), {
        registry,
        onLatency: (s) => seen.push(s),
      });
      vi.advanceTimersByTime(2500);

      expect(seen).toContain(3.5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops measuring once stopped', () => {
    vi.useFakeTimers();
    try {
      const seen: number[] = [];
      const handle = hlsPlay('/hls/preview-a/index.m3u8', videoStub(), {
        registry,
        onLatency: (s) => seen.push(s),
      });
      vi.advanceTimersByTime(1500);
      const taken = seen.length;
      handle.stop();
      vi.advanceTimersByTime(5000);

      expect(seen).toHaveLength(taken);
    } finally {
      vi.useRealTimers();
    }
  });
});
