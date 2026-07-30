import Hls from 'hls.js';
import { PlayerEntry, PlayerRegistry } from './player-registry';

export interface HlsHandle {
  stop: () => void;
}

export interface HlsOptions {
  /**
   * Scene registry to register with, so a route change or a hidden tab destroys
   * this instance. The preview overlay passes nothing — it owns its own
   * teardown and must survive the operator-flows list refreshing underneath it.
   */
  registry?: PlayerRegistry;
  /** Playback has started. The audio preview starts its meters here. */
  onManifest?: () => void;
  /** A fatal error was hit; a reload is already scheduled. */
  onFatal?: () => void;
  /** How long to wait before reloading the source after a fatal error. */
  retryMs?: number;
  /**
   * Latency ceiling before hls.js seeks forward to live. `null` leaves it to
   * hls.js, which is what the preview overlay wants — it is a look at one flow,
   * not a wall of tiles that have to stay in step.
   */
  liveMaxLatencyDurationCount?: number | null;
}

/**
 * HLS playback of a mediamtx path, e.g. `mxl-1` -> /hls/mxl-1/index.m3u8.
 *
 * On EKS every tile ends up here: the WebRTC UDP NLB never completes ICE, so
 * WHEP always fails over.
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

  const stop = () => {
    if (retry !== undefined) {
      clearTimeout(retry);
      retry = undefined;
    }
    if (hls) {
      try {
        hls.destroy();
      } catch {
        // Already destroyed.
      }
      hls = null;
    }
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

  // A WHEP attempt that fell back to here left its (now-dead) MediaStream on the
  // element via pc.ontrack. srcObject takes precedence over an MSE src, so
  // hls.js would attach but never render — the tile freezes on the last WebRTC
  // frame. Drop it so HLS drives the element.
  try {
    video.srcObject = null;
  } catch {
    // Not all elements expose a writable srcObject.
  }

  if (Hls.isSupported()) {
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
    hls.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return;
      onFatal?.();
      retry = setTimeout(() => hls?.loadSource(src), retryMs);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // Safari plays HLS natively; there is no hls.js instance to drive, so hang
    // the same "playback started" signal off the element's own metadata event.
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
