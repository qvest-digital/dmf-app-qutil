import { PlayerEntry, PlayerRegistry } from './player-registry';

export interface WhepHandle {
  stop: () => void;
}

export interface WhepOptions {
  /** Drop to HLS — e.g. a cluster without the UDP ICE LoadBalancer. */
  onFail?: () => void;
  /**
   * The MediaStream, for the audio preview's meters. Reading it back off the
   * element afterwards is racy, so it is handed over here.
   */
  onStream?: (stream: MediaStream) => void;
}

/** How long to wait for ICE gathering before posting the offer anyway. */
const ICE_GATHER_MS = 2500;
/** Overall budget before the attempt is declared a failure and HLS takes over. */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * WHEP playback: mediamtx serves it at /webrtc/<path>/whep (caddy -> :8889).
 *
 * Non-trickle — gather ICE, POST the offer, apply the answer. ICE media does NOT
 * go through Caddy; that's the dedicated UDP LoadBalancer.
 */
export function whep(
  registry: PlayerRegistry,
  path: string,
  video: HTMLVideoElement,
  { onFail, onStream }: WhepOptions = {},
): WhepHandle {
  let done = false;
  let entry: PlayerEntry | null = null;
  let pc: RTCPeerConnection | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const release = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (entry) {
      registry.drop(entry);
      entry = null;
    }
    try {
      pc?.close();
    } catch {
      // Already closed, or never opened.
    }
    pc = null;
  };

  const fail = () => {
    if (done) return;
    done = true;
    release();
    onFail?.();
  };

  // stop() must NOT trigger onFail: that would start a fallback player for a
  // scene we are in the middle of tearing down. The page this replaces got this
  // wrong — its stop() called an undefined `cleanup()`, so the ReferenceError
  // was swallowed by teardownAll's try/catch and the PeerConnection stayed open,
  // which is exactly the leak the registry exists to prevent.
  const stop = () => {
    done = true;
    release();
  };

  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  } catch {
    fail();
    return { stop };
  }

  entry = registry.track({ kind: 'pc', stop });
  timer = setTimeout(fail, CONNECT_TIMEOUT_MS);

  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (e) => {
    if (video.srcObject) return;
    video.srcObject = e.streams[0];
    video.play().catch(() => {
      // Autoplay refused; the element still shows the first frame.
    });
    onStream?.(e.streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    if (pc.connectionState === 'connected') {
      done = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    } else if (pc.connectionState === 'failed') {
      fail();
    }
  };

  const gatherIce = (peer: RTCPeerConnection) =>
    new Promise<void>((resolve) => {
      if (peer.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (peer.iceGatheringState === 'complete') {
          peer.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      peer.addEventListener('icegatheringstatechange', check);
      setTimeout(resolve, ICE_GATHER_MS);
    });

  void (async () => {
    const peer = pc;
    if (!peer) return;
    try {
      await peer.setLocalDescription(await peer.createOffer());
      await gatherIce(peer);
      if (done) return;
      const res = await fetch(`/webrtc/${path}/whep`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/sdp' },
        body: peer.localDescription?.sdp,
      });
      if (!res.ok) throw new Error(`whep ${res.status}`);
      const sdp = await res.text();
      if (done) return;
      await peer.setRemoteDescription({ type: 'answer', sdp });
    } catch {
      fail();
    }
  })();

  return { stop };
}
