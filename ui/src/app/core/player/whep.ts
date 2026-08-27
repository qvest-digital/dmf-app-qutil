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
/** Budget for asking the server which relay to use. */
const ICE_DISCOVER_MS = 3000;

/**
 * The ICE servers out of a WHEP endpoint's Link headers.
 *
 * Format per entry, and several may arrive comma-separated in one header:
 *
 *   <turn:host:3478?transport=tcp>; rel="ice-server"; username="u";
 *     credential="p"; credential-type="password"
 */
export function parseIceServers(header: string): RTCIceServer[] {
  const out: RTCIceServer[] = [];
  // Split only where a new bracketed URI begins: a URI may carry a comma.
  for (const entry of header.split(/,\s*(?=<)/)) {
    const uri = /^\s*<([^>]+)>/.exec(entry);
    if (!uri || !/rel\s*=\s*"?ice-server"?/.test(entry)) continue;
    const server: RTCIceServer = { urls: uri[1] };
    const username = /username\s*=\s*"([^"]*)"/.exec(entry);
    const credential = /credential\s*=\s*"([^"]*)"/.exec(entry);
    if (username) server.username = username[1];
    if (credential) server.credential = credential[1];
    out.push(server);
  }
  return out;
}

/**
 * Ask the media server which relay this client should use.
 *
 * Not a nicety, and not something that can be a constant here. Every candidate
 * the server offers is a pod address: an unsplit instance adds the one public
 * address its UDP load balancer fronts, and a read replica has nothing but the
 * pod. So for a replica the relay is the entire connection rather than a
 * fallback for awkward networks, and which relay to use differs per cluster.
 *
 * WHEP puts the servers on OPTIONS precisely so a client can build its
 * PeerConnection before it has an offer to send; the POST repeats them, by
 * which time it is too late to configure anything.
 */
export async function discoverIceServers(path: string): Promise<RTCIceServer[]> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ICE_DISCOVER_MS);
  try {
    const res = await fetch(`/webrtc/${path}/whep`, {
      method: 'OPTIONS',
      signal: abort.signal,
    });
    const header = res.headers.get('Link');
    return header ? parseIceServers(header) : [];
  } catch {
    // An offer with only host candidates still connects wherever the client
    // shares a network with the server, so this is worth attempting rather
    // than treating as fatal.
    return [];
  } finally {
    clearTimeout(timer);
  }
}
/**
 * Budget for getting an answer: the preflight, the offer, and the POST.
 *
 * Generous, because most of it is the server's and not the connection's. A
 * preview path is created on demand, so the first offer for a flow is answered
 * only once the server has opened it, started an encoder and produced a frame,
 * and where the flow has to be mirrored to that node first it is seconds
 * before any of that begins. None of that says anything about whether the
 * connection will work.
 */
const SETUP_TIMEOUT_MS = 20000;
/**
 * Budget for the connection itself, once there is an answer to connect with.
 *
 * Counted from the answer rather than from the start of the attempt. Sharing
 * one budget with the setup above meant a slow source spent it: measured on
 * one cluster, a cold offer took five of eight seconds to be answered, leaving
 * too little for the candidate exchange, so the card fell back to HLS on a
 * connection that would have formed.
 */
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

  entry = registry.track({ kind: 'pc', stop });
  timer = setTimeout(fail, SETUP_TIMEOUT_MS);

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
    // Before the connection exists: iceServers is read at construction and
    // cannot be supplied to a PeerConnection afterwards.
    const iceServers = await discoverIceServers(path);
    if (done) return;

    try {
      pc = new RTCPeerConnection({ iceServers });
    } catch {
      fail();
      return;
    }
    const peer = pc;

    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });

    peer.ontrack = (e) => {
      if (video.srcObject) return;
      video.srcObject = e.streams[0];
      video.play().catch(() => {
        // Autoplay refused; the element still shows the first frame.
      });
      onStream?.(e.streams[0]);
    };

    peer.onconnectionstatechange = () => {
      if (peer.connectionState === 'connected') {
        done = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      } else if (peer.connectionState === 'failed') {
        fail();
      }
    };

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
      if (done) return;
      // The setup is over and the connection starts here, so the budget does
      // too. Whatever the server spent answering is not the candidate
      // exchange's to pay for.
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(fail, CONNECT_TIMEOUT_MS);
    } catch {
      fail();
    }
  })();

  return { stop };
}
