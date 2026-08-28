import { vi } from 'vitest';
import { PlayerRegistry } from './player-registry';
import { whep } from './whep';

/**
 * A connection that comes up and then stops is the failure this covers.
 *
 * The player it replaces treated connecting as the end of its responsibility:
 * a flag cleared the setup timeout and, with the same flag, disarmed the
 * failure handler. Everything after that -- a peer that closed, ICE that
 * failed, a source that stopped producing -- was swallowed, and the card sat
 * on its last decoded frame until someone reloaded the page.
 */

const OFFER_SDP = [
  'v=0',
  'a=ice-ufrag:aaaa',
  'a=ice-pwd:bbbb',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111',
  'a=mid:1',
  '',
].join('\r\n');

interface Stat {
  type: string;
  id: string;
  kind?: string;
  framesDecoded?: number;
  bytesReceived?: number;
}

class FakePeerConnection {
  static built: FakePeerConnection[] = [];

  iceGatheringState = 'complete';
  connectionState = 'new';
  closed = false;
  ontrack: ((e: unknown) => void) | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  stats = new Map<string, Stat>();

  constructor() {
    FakePeerConnection.built.push(this);
  }

  addTransceiver(): void {}
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: OFFER_SDP, type: 'offer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async getStats(): Promise<Map<string, Stat>> {
    return this.stats;
  }
  close(): void {
    this.closed = true;
  }

  /** Drive a connection-state transition the way the browser would. */
  enter(state: string): void {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  /** Advance the video track by `frames`, or repeat the last count to freeze it. */
  decode(frames: number): void {
    const previous = this.stats.get('v')?.framesDecoded ?? 0;
    this.stats.set('v', {
      type: 'inbound-rtp',
      id: 'v',
      kind: 'video',
      framesDecoded: previous + frames,
    });
  }
}

interface Call {
  url: string;
  method: string;
  body?: string;
}

describe('whep recovery', () => {
  const realFetch = globalThis.fetch;
  const realPC = (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection;
  let calls: Call[];
  let registry: PlayerRegistry;
  let video: HTMLVideoElement;

  const SESSION = '/webrtc/preview-x/whep/session-1';

  beforeEach(() => {
    vi.useFakeTimers();
    calls = [];
    FakePeerConnection.built = [];
    registry = new PlayerRegistry();
    video = { play: () => Promise.resolve(), srcObject: null } as unknown as HTMLVideoElement;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    globalThis.fetch = ((url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string });
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response('v=0', { status: 201, headers: { Location: SESSION } }),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection = realPC;
    vi.useRealTimers();
  });

  /** Take a session all the way to connected and return its PeerConnection. */
  async function connect(options = {}) {
    const handle = whep(registry, 'preview-x', video, options);
    await vi.advanceTimersByTimeAsync(0);
    const peer = FakePeerConnection.built.at(-1)!;
    peer.decode(1);
    peer.enter('connected');
    return { handle, peer };
  }

  /** Let time pass with the source still delivering, so nothing reads as stalled. */
  async function playFor(peer: FakePeerConnection, ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 500) {
      peer.decode(15);
      await vi.advanceTimersByTimeAsync(500);
    }
  }

  it('rebuilds a connection that fails after it was up', async () => {
    const { peer } = await connect();
    expect(FakePeerConnection.built).toHaveLength(1);

    peer.enter('failed');
    await vi.advanceTimersByTimeAsync(2500);

    expect(peer.closed).toBe(true);
    expect(FakePeerConnection.built).toHaveLength(2);
  });

  /**
   * "closed" arrives instead of "failed" when the peer sends a DTLS
   * CloseNotify, so a handler that waits for "failed" never runs at all.
   */
  it('treats a closed peer as a failure', async () => {
    const { peer } = await connect();

    peer.enter('closed');
    await vi.advanceTimersByTimeAsync(2500);

    expect(FakePeerConnection.built).toHaveLength(2);
  });

  /**
   * ICE recovers from "disconnected" on its own often enough that rebuilding
   * on sight would throw away connections that were coming back.
   */
  it('gives disconnected a grace period and keeps the connection if it returns', async () => {
    const { peer } = await connect();

    peer.enter('disconnected');
    await playFor(peer, 1000);
    peer.enter('connected');
    await playFor(peer, 5000);

    expect(FakePeerConnection.built).toHaveLength(1);
    expect(peer.closed).toBe(false);
  });

  it('rebuilds when disconnected does not clear', async () => {
    const { peer } = await connect();

    peer.enter('disconnected');
    await vi.advanceTimersByTimeAsync(5000);

    expect(FakePeerConnection.built).toHaveLength(2);
  });

  /**
   * The freeze with no error attached to it.
   *
   * A path whose source restarts, a writer recreating the flow, a wedged
   * mirror: the media stops and the transport stays `connected` throughout.
   * Nothing in the PeerConnection API reports it, so only the fact that no
   * frame has decoded for seconds can.
   */
  it('rebuilds when frames stop decoding on a connection that stays up', async () => {
    const { peer } = await connect();

    // The counter stands still past the stall timeout, and then the rebuild
    // pause, while the state never leaves "connected".
    await vi.advanceTimersByTimeAsync(8000);

    expect(peer.connectionState).toBe('connected');
    expect(peer.closed).toBe(true);
    expect(FakePeerConnection.built).toHaveLength(2);
  });

  it('leaves a connection alone while frames keep decoding', async () => {
    const { peer } = await connect();
    await playFor(peer, 10000);

    expect(FakePeerConnection.built).toHaveLength(1);
  });

  it('reports the jitter buffer so a late preview can be told from a late source', async () => {
    const seen: (number | null)[] = [];
    const { peer } = await connect({
      onStats: (s: { jitterDelayS: number | null }) => seen.push(s.jitterDelayS),
    });

    peer.stats.set('a', {
      type: 'inbound-rtp',
      id: 'a',
      kind: 'audio',
      bytesReceived: 1000,
      // 4.8 s of buffer over 48000 emitted samples.
      jitterBufferDelay: 4.8,
      jitterBufferEmittedCount: 48000,
    } as Stat);
    await vi.advanceTimersByTimeAsync(1000);

    expect(seen.at(-1)).toBeCloseTo(0.0001, 6);
  });

  it('gives up on WHEP once the rebuilds are spent', async () => {
    let failed = 0;
    const attempts: number[] = [];
    whep(registry, 'preview-x', video, {
      onFail: () => failed++,
      onRetry: (n) => attempts.push(n),
    });
    await vi.advanceTimersByTimeAsync(0);

    // Never connecting: each attempt burns its connect budget, then rebuilds.
    await vi.advanceTimersByTimeAsync(120000);

    expect(attempts).toEqual([1, 2, 3]);
    expect(failed).toBe(1);
    expect(registry.counts().pc).toBe(0);
  });

  /**
   * The server drops a reader once it notices the peer is gone, but not
   * before. Until then the path stays up, and the encoder behind it with it.
   */
  it('deletes the session resource on the way out', async () => {
    const { handle } = await connect();
    handle.stop();

    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([SESSION]);
  });

  it('does not report failure when it is stopped', async () => {
    let failed = 0;
    const { handle } = await connect({ onFail: () => failed++ });

    handle.stop();
    await vi.advanceTimersByTimeAsync(60000);

    expect(failed).toBe(0);
    expect(FakePeerConnection.built).toHaveLength(1);
  });

  /**
   * Gathering cost the connection everything it took, which on a relay-only
   * path is the whole TURN exchange. Candidates go over PATCH instead, so the
   * offer leaves as soon as it exists.
   */
  /**
   * An offer still in flight when the setup budget expires lands after the
   * rebuild has already started. The state is back at "setup" by then, so a
   * check on the state alone lets the stale attempt adopt its PeerConnection
   * over the live one, and the connection it replaces is never closed.
   */
  it('discards an attempt that lands after its own rebuild started', async () => {
    let release: ((r: Response) => void) | null = null;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(new Response('v=0', { status: 201 }));
      }
      // The first preflight never answers, so its attempt is still ahead of
      // building a PeerConnection when the setup budget runs out.
      if (!release) {
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    whep(registry, 'preview-x', video, {});
    // Past the setup budget and the rebuild pause, so a second attempt is up.
    await vi.advanceTimersByTimeAsync(23000);
    expect(FakePeerConnection.built).toHaveLength(1);
    const live = FakePeerConnection.built[0];

    // Now the first preflight finally answers.
    release!(new Response(null, { status: 204 }));
    await vi.advanceTimersByTimeAsync(0);

    // It built nothing, so the live connection is still the one held.
    expect(FakePeerConnection.built).toHaveLength(1);
    expect(live.closed).toBe(false);
  });

  it('trickles candidates rather than holding the offer for gathering', async () => {
    const { peer } = await connect();
    peer.onicecandidate?.({
      candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', sdpMLineIndex: 0 },
    });
    await vi.advanceTimersByTimeAsync(0);

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.url).toBe(SESSION);
    expect(patch?.body).toContain('a=ice-ufrag:aaaa');
    expect(patch?.body).toContain('candidate:1 1 udp 1 10.0.0.1 1 typ host');
  });

  /**
   * A rebuild produces a new MediaStream. Refusing to replace the one already
   * on the element is what leaves a reconnected card showing the last frame of
   * a connection that is gone.
   */
  it('puts the new stream on the element after a rebuild', async () => {
    const first = { id: 'first' } as unknown as MediaStream;
    const second = { id: 'second' } as unknown as MediaStream;
    const { peer } = await connect();

    peer.ontrack?.({ streams: [first] });
    expect(video.srcObject).toBe(first);

    peer.enter('failed');
    await vi.advanceTimersByTimeAsync(2500);
    FakePeerConnection.built.at(-1)!.ontrack?.({ streams: [second] });

    expect(video.srcObject).toBe(second);
  });
});
