import Hls, { type ErrorData } from 'hls.js';
import { PlayerEntry, PlayerRegistry } from './player-registry';

export interface HlsHandle {
  stop: () => void;
}

export interface HlsOptions {
  /**
   * Scene registry to register with, so a route change or a hidden tab destroys
   * this instance. The preview overlay passes nothing -- it owns its own
   * teardown and must survive the operator-flows list refreshing underneath it.
   */
  registry?: PlayerRegistry;
  /** Playback has started. The audio preview starts its meters here. */
  onManifest?: () => void;
  /** A fatal error was hit; recovery is already under way. */
  onFatal?: () => void;
  /** How long to wait before the next recovery attempt after a fatal error. */
  retryMs?: number;
  /**
   * Latency ceiling before hls.js seeks forward to live. `null` leaves it to
   * hls.js, which is what the preview overlay wants -- it is a look at one flow,
   * not a wall of tiles that have to stay in step.
   */
  liveMaxLatencyDurationCount?: number | null;
}

/**
 * HLS playback of a mediamtx path, e.g. `mxl-1` -> /hls/mxl-1/index.m3u8.
 *
 * Every tile ends up here wherever WHEP cannot complete ICE.
 */
export function hlsPlay(src: string, video: HTMLVideoElement, options: HlsOptions = {}): HlsHandle {
  const {
    registry,
    onManifest,
    onFatal,
    retryMs = 5000,
    liveMaxLatencyDurationCount = 8,
  } = options;
  let hls: Hls | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let entry: PlayerEntry | null = null;
  let stopped = false;
  /** When the last media-error recovery ran, so it cannot run in a tight loop. */
  let recoveredAt = 0;

  const clearRetry = () => {
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
  };

  const destroyHls = () => {
    if (!hls) return;
    try {
      hls.destroy();
    } catch {
      // Already destroyed.
    }
    hls = null;
  };

  const stop = () => {
    stopped = true;
    clearRetry();
    destroyHls();
    try {
      video.removeAttribute('src');
      video.load();
    } catch {
      // The element is gone; nothing left to reset.
    }
    if (entry) {
      registry?.drop(entry);
      entry = null;
    }
  };

  if (registry) entry = registry.track({ kind: 'hls', stop });

  /** Replace the instance. The element keeps its place in the grid. */
  const rebuild = () => {
    destroyHls();
    clearRetry();
    retry = setTimeout(() => {
      if (stopped) return;
      attach();
    }, retryMs);
  };

  /**
   * A fatal error means hls.js has already exhausted its own retries, so the
   * response has to match the error type. Reloading the source instead only
   * re-fetches the playlist without resetting the pipeline: the tile stays black
   * while mediamtx opens a fresh HLS session per attempt.
   */
  const onError = (_event: unknown, data: ErrorData) => {
    if (!data.fatal || stopped) return;
    onFatal?.();
    clearRetry();

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      // Resets the MediaSource and resumes from the playhead. Rate-limited
      // because a source that keeps failing to decode would otherwise be
      // recovered on every error in a loop.
      const now = Date.now();
      if (now - recoveredAt < retryMs) return;
      recoveredAt = now;
      try {
        hls?.recoverMediaError();
      } catch {
        rebuild();
      }
      return;
    }

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // Loading is what failed, so resume loading rather than rebuild. Not
      // immediately: hls.js documents restarting at once as a way to loop.
      retry = setTimeout(() => {
        if (stopped) return;
        try {
          hls?.startLoad();
        } catch {
          rebuild();
        }
      }, retryMs);
      return;
    }

    // Nothing left to recover on this instance.
    rebuild();
  };

  /** Drop a dead MediaStream, then build and attach an instance. */
  const attach = () => {
    // A WHEP attempt that fell back to here left its (now-dead) MediaStream on
    // the element via pc.ontrack. srcObject takes precedence over an MSE src, so
    // hls.js would attach but never render -- the tile freezes on the last
    // WebRTC frame. Drop it so HLS drives the element.
    try {
      video.srcObject = null;
    } catch {
      // Not all elements expose a writable srcObject.
    }

    hls = new Hls({
      liveSyncDurationCount: 3,
      ...(liveMaxLatencyDurationCount == null ? {} : { liveMaxLatencyDurationCount }),
      enableWorker: true,
      lowLatencyMode: false,
    });
    hls.loadSource(src);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {
        // Autoplay refused.
      });
      onManifest?.();
    });
    hls.on(Hls.Events.ERROR, onError);
  };

  if (Hls.isSupported()) {
    attach();
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari plays HLS natively; there is no hls.js instance to drive, so hang
    // the same "playback started" signal off the element's own metadata event.
    try {
      video.srcObject = null;
    } catch {
      // Not all elements expose a writable srcObject.
    }
    video.src = src;
    video.addEventListener('loadedmetadata', () => {
      video.play().catch(() => {
        // Autoplay refused.
      });
      onManifest?.();
    });
  }

  return { stop };
}

/** The mediamtx HLS playlist for a path, as Caddy exposes it (`handle_path /hls/*`). */
export function hlsUrl(path: string): string {
  return `/hls/${path}/index.m3u8`;
}
