import { PlayerEntry, PlayerRegistry } from './player-registry';

export interface WhepHandle {
  stop: () => void;
}

/**
 * What the connection is doing, for the card to show and for a latency
 * measurement to be read off rather than guessed at.
 */
export interface WhepStats {
  /**
   * Seconds the browser's own jitter buffer is holding, averaged over what it
   * has emitted. This is the one number that separates a delay the page can
   * fix from one it cannot: a reconnect drops this and nothing else, so a
   * preview that is seconds late with a millisecond buffer is late upstream.
   */
  jitterDelayS: number | null;
  /** Round-trip time on the selected candidate pair, when the pair reports one. */
  rttS: number | null;
  packetsLost: number;
  /** Rebuilds spent, so a card that keeps reconnecting says so. */
  attempts: number;
}

export interface WhepOptions {
  /** Every attempt is spent; the caller falls back to HLS. */
  onFail?: () => void;
  /**
   * The MediaStream, for the audio preview's meters. Reading it back off the
   * element afterwards is racy, so it is handed over here. Called again after
   * a rebuild, because that is a different stream.
   */
  onStream?: (stream: MediaStream) => void;
  /** The latest measurement, once per stats poll. */
  onStats?: (stats: WhepStats) => void;
  /** The connection dropped and is being rebuilt. */
  onRetry?: (attempt: number) => void;
}

/** Budget for asking the server which relay to use. */
const ICE_DISCOVER_MS = 3000;
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
/** How often the connection is measured, and checked for having gone quiet. */
const STATS_POLL_MS = 1000;
/**
 * How long a track may deliver nothing before the connection counts as dead.
 *
 * The transport stays `connected` through all of it: a path whose source is
 * restarting, a writer recreating the flow, a wedged mirror. Nothing in the
 * PeerConnection API reports that, so the receiver counters are the only
 * evidence, and without this the card sits on its last decoded frame for as
 * long as it is left open.
 */
const STALL_TIMEOUT_MS = 3000;
/**
 * Grace for `disconnected`, which is a warning rather than a verdict: ICE
 * recovers from it on its own often enough that rebuilding immediately would
 * cost a connection that was about to come back.
 */
const DISCONNECT_GRACE_MS = 2000;
/** Pause before rebuilding, so a server that is down is not hammered. */
const RETRY_PAUSE_MS = 2000;
/**
 * Rebuilds before the caller is told to try another transport.
 *
 * Spending them is what distinguishes a path that is still opening from one
 * WebRTC cannot reach at all, and only the second is worth the playlist window
 * HLS costs.
 */
const MAX_ATTEMPTS = 3;
/**
 * How long a connection has to keep delivering before it counts as sound and
 * its attempts are given back. Without it, a card that reconnects cleanly once
 * an hour would eventually run the budget down and drop to HLS for good.
 */
const STABLE_MS = 15000;

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

/** The ICE credentials and media lines a trickled candidate has to be sent with. */
export interface OfferData {
  iceUfrag: string;
  icePwd: string;
  medias: string[];
}

/** Read back what a PATCH has to repeat for the server to place a candidate. */
export function parseOffer(sdp: string): OfferData {
  const out: OfferData = { iceUfrag: '', icePwd: '', medias: [] };
  for (const line of sdp.split('\r\n')) {
    if (line.startsWith('m=')) out.medias.push(line.slice('m='.length));
    else if (!out.iceUfrag && line.startsWith('a=ice-ufrag:')) {
      out.iceUfrag = line.slice('a=ice-ufrag:'.length);
    } else if (!out.icePwd && line.startsWith('a=ice-pwd:')) {
      out.icePwd = line.slice('a=ice-pwd:'.length);
    }
  }
  return out;
}

/** The trickle-ice-sdpfrag body carrying candidates for an established session. */
export function generateSdpFragment(offer: OfferData, candidates: RTCIceCandidate[]): string {
  const byMedia = new Map<number, RTCIceCandidate[]>();
  for (const candidate of candidates) {
    const mid = candidate.sdpMLineIndex;
    if (mid === null) continue;
    const list = byMedia.get(mid);
    if (list) list.push(candidate);
    else byMedia.set(mid, [candidate]);
  }

  let frag = `a=ice-ufrag:${offer.iceUfrag}\r\na=ice-pwd:${offer.icePwd}\r\n`;
  offer.medias.forEach((media, mid) => {
    const list = byMedia.get(mid);
    if (!list) return;
    frag += `m=${media}\r\na=mid:${mid}\r\n`;
    for (const candidate of list) frag += `a=${candidate.candidate}\r\n`;
  });
  return frag;
}

/**
 * Ask for stereo Opus.
 *
 * RFC 7587 defaults the offerer to mono, so a browser that says nothing is
 * telling the server to downmix. An audio preview exists to hear a stereo pair
 * of a flow's channels, which is exactly what that throws away.
 */
export function enableStereoOpus(sdp: string): string {
  const sections = sdp.split('m=');
  for (let i = 1; i < sections.length; i++) {
    if (!sections[i].startsWith('audio')) continue;
    const lines = sections[i].split('\r\n');
    const rtpmap = lines.find(
      (line) => line.startsWith('a=rtpmap:') && line.toLowerCase().includes('opus/'),
    );
    if (!rtpmap) break;
    const payload = rtpmap.slice('a=rtpmap:'.length).split(' ')[0];
    for (let j = 0; j < lines.length; j++) {
      if (!lines[j].startsWith(`a=fmtp:${payload} `)) continue;
      if (!lines[j].includes('stereo')) lines[j] += ';stereo=1';
      if (!lines[j].includes('sprop-stereo')) lines[j] += ';sprop-stereo=1';
    }
    sections[i] = lines.join('\r\n');
    break;
  }
  return sections.join('m=');
}

/** One inbound track's progress: the counter that proves it is still moving. */
interface TrackProgress {
  counter: number;
  at: number;
}

/** The stats members read here. getStats() is typed as a bag of unknowns. */
interface InboundStats {
  type: string;
  id: string;
  kind?: string;
  framesDecoded?: number;
  bytesReceived?: number;
  packetsLost?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  currentRoundTripTime?: number;
}

/**
 * WHEP playback: mediamtx serves it at /webrtc/<path>/whep (caddy -> :8889).
 *
 * Ported from the media server's own reader, which is the client its WHEP
 * implementation is developed against: trickle ICE over PATCH, the session
 * DELETE on the way out, and a rebuild whenever the connection drops. ICE
 * media does NOT go through Caddy; that is the dedicated UDP LoadBalancer.
 *
 * What is added on top is the stall watch. The media server takes a path down
 * when either of its tracks stops, but nothing tells the browser: the
 * PeerConnection stays `connected` with no media in it. Only the receiver
 * counters see that, so they are polled, and the poll doubles as the latency
 * readout the card shows.
 *
 * ICE restart is deliberately not used. It would keep the session, but the
 * thing worth keeping is the encoder, and `sourceOnDemandCloseAfter` holds
 * that for ten seconds after the last reader leaves -- longer than a rebuild
 * takes. A fresh session inside that window costs a handshake and no re-open,
 * which is why the media server's own client does not implement one either.
 */
class WhepSession {
  private state: 'setup' | 'running' | 'restarting' | 'stopped' = 'setup';
  private entry: PlayerEntry | null;
  private pc: RTCPeerConnection | null = null;
  private sessionUrl: string | null = null;
  private offer: OfferData | null = null;
  private queued: RTCIceCandidate[] = [];
  private budget: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disconnect: ReturnType<typeof setTimeout> | undefined;
  private stats: ReturnType<typeof setInterval> | undefined;
  private readonly progress = new Map<string, TrackProgress>();
  private attempts = 0;
  private connectedAt = 0;
  /** Which attempt is the live one, so a late continuation can tell it is not. */
  private generation = 0;

  constructor(
    private readonly registry: PlayerRegistry,
    private readonly path: string,
    private readonly video: HTMLVideoElement,
    private readonly options: WhepOptions,
  ) {
    this.entry = registry.track({ kind: 'pc', stop: () => this.stop() });
    this.start();
  }

  /**
   * Tear down for good.
   *
   * Must NOT report failure: that would start a fallback player for a scene
   * being torn down. The page this replaces got it wrong -- its stop() called
   * an undefined cleanup(), and the ReferenceError was swallowed by
   * teardownAll's try/catch, so the PeerConnection stayed open.
   */
  stop(): void {
    if (this.state === 'stopped') return;
    this.state = 'stopped';
    this.closeSession();
    if (this.retry !== undefined) clearTimeout(this.retry);
    this.retry = undefined;
    this.release();
  }

  private release(): void {
    if (!this.entry) return;
    this.registry.drop(this.entry);
    this.entry = null;
  }

  /** Drop this attempt's connection and release the server's half of it. */
  private closeSession(): void {
    for (const timer of [this.budget, this.disconnect]) {
      if (timer !== undefined) clearTimeout(timer);
    }
    this.budget = undefined;
    this.disconnect = undefined;
    if (this.stats !== undefined) clearInterval(this.stats);
    this.stats = undefined;
    this.progress.clear();
    this.connectedAt = 0;

    if (this.sessionUrl) {
      // The server drops the reader on its own once it notices the peer is
      // gone, but not before: without this a closed card holds its path, and
      // the encoder behind it, for as long as that takes.
      void fetch(this.sessionUrl, { method: 'DELETE' }).catch(() => undefined);
      this.sessionUrl = null;
    }
    try {
      this.pc?.close();
    } catch {
      // Already closed, or never opened.
    }
    this.pc = null;
    this.offer = null;
    this.queued = [];
  }

  /**
   * The connection is gone. Rebuild it, or hand the caller to another
   * transport once the attempts are spent.
   */
  private handleError(): void {
    if (this.state === 'stopped' || this.state === 'restarting') return;
    this.closeSession();

    if (this.attempts >= MAX_ATTEMPTS) {
      this.state = 'stopped';
      this.release();
      this.options.onFail?.();
      return;
    }

    this.attempts++;
    this.state = 'restarting';
    this.options.onRetry?.(this.attempts);
    this.retry = setTimeout(() => {
      this.retry = undefined;
      if (this.state !== 'restarting') return;
      this.state = 'setup';
      this.start();
    }, RETRY_PAUSE_MS);
  }

  private start(): void {
    // The state alone cannot say whose attempt this is. An offer still in
    // flight when the setup budget expires lands after the rebuild has already
    // started, finds the state back at "setup", and adopts a PeerConnection
    // over the live one -- leaking the connection it replaces.
    const attempt = ++this.generation;
    const current = () => this.state === 'setup' && this.generation === attempt;

    this.budget = setTimeout(() => this.handleError(), SETUP_TIMEOUT_MS);
    void (async () => {
      try {
        // Before the connection exists: iceServers is read at construction and
        // cannot be supplied to a PeerConnection afterwards.
        const iceServers = await discoverIceServers(this.path);
        if (!current()) return;

        const sdp = await this.setupPeerConnection(iceServers);
        if (!current()) return;

        const answer = await this.sendOffer(sdp);
        if (!current()) return;

        // The setup is over and the connection starts here, so the budget does
        // too. Whatever the server spent answering is not the candidate
        // exchange's to pay for.
        if (this.budget !== undefined) clearTimeout(this.budget);
        this.budget = setTimeout(() => this.handleError(), CONNECT_TIMEOUT_MS);

        await this.setAnswer(answer);
      } catch {
        if (this.generation === attempt) this.handleError();
      }
    })();
  }

  private async setupPeerConnection(iceServers: RTCIceServer[]): Promise<string> {
    const peer = new RTCPeerConnection({ iceServers });
    this.pc = peer;

    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });

    peer.onicecandidate = (e) => this.onLocalCandidate(e.candidate);
    peer.onconnectionstatechange = () => this.onConnectionState(peer);
    peer.ontrack = (e) => this.onTrack(e);

    const offer = await peer.createOffer();
    const sdp = enableStereoOpus(offer.sdp ?? '');
    this.offer = parseOffer(sdp);
    await peer.setLocalDescription({ type: 'offer', sdp });
    return sdp;
  }

  /**
   * Post the offer without waiting for gathering.
   *
   * Gathering cost the connection everything it took, which on a relay-only
   * path is the whole TURN exchange. The server takes candidates over PATCH
   * afterwards, so the offer goes as soon as it exists.
   */
  private async sendOffer(sdp: string): Promise<string> {
    const res = await fetch(`/webrtc/${this.path}/whep`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdp,
    });
    if (!res.ok) throw new Error(`whep ${res.status}`);
    // The media server answers with an absolute path and Caddy rewrites it
    // back under /webrtc, so it is same-origin and needs no resolving. A
    // sticky proxy routes it to the replica that answered by the cookie the
    // preflight already set, which fetch sends back with it.
    this.sessionUrl = res.headers.get('Location');
    return res.text();
  }

  private async setAnswer(sdp: string): Promise<void> {
    await this.pc?.setRemoteDescription({ type: 'answer', sdp });
    if (this.state !== 'setup') return;
    if (this.queued.length) {
      const pending = this.queued;
      this.queued = [];
      this.sendCandidates(pending);
    }
  }

  private onLocalCandidate(candidate: RTCIceCandidate | null): void {
    if (!candidate || this.state === 'stopped') return;
    // There is nowhere to send them until the session exists; they go with the
    // first PATCH once it does.
    if (!this.sessionUrl) this.queued.push(candidate);
    else this.sendCandidates([candidate]);
  }

  private sendCandidates(candidates: RTCIceCandidate[]): void {
    const url = this.sessionUrl;
    const offer = this.offer;
    if (!url || !offer) return;
    void fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/trickle-ice-sdpfrag',
        'If-Match': '*',
      },
      body: generateSdpFragment(offer, candidates),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`patch ${res.status}`);
      })
      .catch(() => this.handleError());
  }

  private onTrack(e: RTCTrackEvent): void {
    const stream = e.streams[0];
    if (!stream || this.video.srcObject === stream) return;
    // Assigned rather than skipped when the element already has one: a rebuild
    // produces a new stream and the old one is dead, so refusing to replace it
    // is exactly what leaves a reconnected card frozen on the previous frame.
    this.video.srcObject = stream;
    this.video.play().catch(() => {
      // Autoplay refused; the element still shows the first frame.
    });
    this.options.onStream?.(stream);
  }

  private onConnectionState(peer: RTCPeerConnection): void {
    if (this.pc !== peer || this.state === 'stopped') return;

    if (peer.connectionState === 'connected') {
      this.state = 'running';
      this.connectedAt = Date.now();
      if (this.budget !== undefined) clearTimeout(this.budget);
      this.budget = undefined;
      if (this.disconnect !== undefined) clearTimeout(this.disconnect);
      this.disconnect = undefined;
      this.stats ??= setInterval(() => void this.poll(), STATS_POLL_MS);
      return;
    }

    // "closed" can arrive instead of "failed" when the peer sends a DTLS
    // CloseNotify, so treating only "failed" as terminal misses it entirely.
    if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
      this.handleError();
      return;
    }

    // ICE recovers from "disconnected" often enough that rebuilding at once
    // would throw away connections that were coming back, so it gets a grace.
    if (peer.connectionState === 'disconnected' && this.disconnect === undefined) {
      this.disconnect = setTimeout(() => {
        this.disconnect = undefined;
        if (this.pc === peer && peer.connectionState === 'disconnected') this.handleError();
      }, DISCONNECT_GRACE_MS);
    }
  }

  /**
   * Measure the connection, and notice it having gone quiet.
   *
   * A track is stuck when its own counter stops: frames for video, because a
   * picture freezes while bytes still arrive, and bytes for audio, which
   * decodes no frames. Either one is a rebuild, which is what the media server
   * does to the path itself when half of a joined source stops.
   */
  private async poll(): Promise<void> {
    const peer = this.pc;
    if (!peer || this.state !== 'running') return;

    let report: RTCStatsReport;
    try {
      report = await peer.getStats();
    } catch {
      return;
    }
    if (this.pc !== peer || this.state !== 'running') return;

    const now = Date.now();
    let jitterDelay = 0;
    let jitterCount = 0;
    let packetsLost = 0;
    let rttS: number | null = null;
    let stalled = false;

    report.forEach((raw) => {
      const stat = raw as InboundStats;
      if (stat.type === 'candidate-pair' && stat.currentRoundTripTime !== undefined) {
        rttS = stat.currentRoundTripTime;
        return;
      }
      if (stat.type !== 'inbound-rtp') return;

      packetsLost += stat.packetsLost ?? 0;
      if (stat.jitterBufferDelay !== undefined && stat.jitterBufferEmittedCount) {
        jitterDelay += stat.jitterBufferDelay;
        jitterCount += stat.jitterBufferEmittedCount;
      }

      const counter = stat.kind === 'video' ? stat.framesDecoded : stat.bytesReceived;
      if (counter === undefined) return;
      const seen = this.progress.get(stat.id);
      if (!seen) this.progress.set(stat.id, { counter, at: now });
      else if (counter > seen.counter) {
        seen.counter = counter;
        seen.at = now;
      } else if (now - seen.at > STALL_TIMEOUT_MS) stalled = true;
    });

    this.options.onStats?.({
      jitterDelayS: jitterCount ? jitterDelay / jitterCount : null,
      rttS,
      packetsLost,
      attempts: this.attempts,
    });

    // Given back only once it has held, so a connection that reconnects
    // cleanly now and then never runs the budget down.
    if (!stalled && this.connectedAt && now - this.connectedAt > STABLE_MS) this.attempts = 0;
    if (stalled) this.handleError();
  }
}

export function whep(
  registry: PlayerRegistry,
  path: string,
  video: HTMLVideoElement,
  options: WhepOptions = {},
): WhepHandle {
  const session = new WhepSession(registry, path, video, options);
  return { stop: () => session.stop() };
}
