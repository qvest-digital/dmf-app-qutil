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
 * HLS playback of a mediamtx playlist, which Caddy exposes under
 * `handle_path /hls/*` and the aggregator names in a preview session.
 *
 * The preview overlay ends up here wherever WHEP cannot complete ICE.
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
   * response has to match the error type. The two differ in what has to be
   * rebuilt, and getting either wrong leaves the element black until the page
   * is reloaded.
   */
  const onError = (_event: unknown, data: ErrorData) => {
    if (!data.fatal || stopped) return;
    onFatal?.();
    clearRetry();

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      // The pipeline is what failed, so reset the MediaSource and resume from
      // the playhead. Re-fetching the playlist instead leaves the pipeline in
      // place and the element black, while the server opens a session per
      // attempt. Rate-limited because a source that keeps failing to decode
      // would otherwise be recovered on every error in a loop.
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
      // The manifest is what failed, and loading it again is the only thing
      // that recovers it. startLoad is not that: it takes effect only once a
      // manifest has been parsed, so on a path that was not being served yet
      // it does nothing and the element never comes back. Paths here are
      // created on demand, so a player that starts before its path is serving
      // is the normal case, not an edge one.
      //
      // Not immediately: restarting at once is a documented way to loop.
      retry = setTimeout(() => {
        if (stopped) return;
        try {
          hls?.loadSource(src);
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
