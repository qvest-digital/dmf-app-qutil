import { vi } from 'vitest';
import { PlayerRegistry } from './player-registry';
import { whep } from './whep';

/**
 * A card previewing a wide flow opens one connection per pair, and only one
 * of them is meant to reach the speakers. The rest exist purely to meter
 * their pair, so they must never touch the video element they are handed --
 * here, no element at all.
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

class FakePeerConnection {
  static built: FakePeerConnection[] = [];
  connectionState = 'new';
  ontrack: ((e: { streams: MediaStream[] }) => void) | null = null;
  onicecandidate: ((e: { candidate: RTCIceCandidate | null }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;

  constructor() {
    FakePeerConnection.built.push(this);
  }

  addTransceiver(): void {}
  async createOffer(): Promise<{ sdp: string; type: string }> {
    return { sdp: OFFER_SDP, type: 'offer' };
  }
  async setLocalDescription(): Promise<void> {}
  async setRemoteDescription(): Promise<void> {}
  async getStats(): Promise<Map<string, unknown>> {
    return new Map();
  }
  close(): void {}
}

describe('whep with no video element', () => {
  const realFetch = globalThis.fetch;
  const realPC = (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection;
  let registry: PlayerRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.built = [];
    registry = new PlayerRegistry();
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response('v=0', { status: 201, headers: { Location: '/session-1' } }),
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

  it('hands the stream to the caller with no video element to attach it to', async () => {
    const stream = {} as MediaStream;
    let handed: MediaStream | undefined;
    whep(registry, 'preview-x-p1-2', null, { onStream: (s) => (handed = s) });
    await vi.advanceTimersByTimeAsync(0);
    const peer = FakePeerConnection.built.at(-1)!;

    peer.ontrack?.({ streams: [stream] });

    expect(handed).toBe(stream);
  });

  it('builds and stops without an element at all', async () => {
    const handle = whep(registry, 'preview-x-p1-2', null, {});
    await vi.advanceTimersByTimeAsync(0);
    expect(() => handle.stop()).not.toThrow();
  });
});

describe('whep with a video element, regression case', () => {
  const realFetch = globalThis.fetch;
  const realPC = (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection;
  let registry: PlayerRegistry;

  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.built = [];
    registry = new PlayerRegistry();
    (globalThis as unknown as { RTCPeerConnection: unknown }).RTCPeerConnection =
      FakePeerConnection;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(
          new Response('v=0', { status: 201, headers: { Location: '/session-1' } }),
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

  it('fires onStream only once when ontrack fires twice with the same stream', async () => {
    const stream = {} as MediaStream;
    const video = {
      srcObject: null,
      play: () => Promise.resolve(),
    } as unknown as HTMLVideoElement;
    let onStreamCallCount = 0;
    whep(registry, 'preview-x-p1-2', video, {
      onStream: () => {
        onStreamCallCount++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const peer = FakePeerConnection.built.at(-1)!;

    peer.ontrack?.({ streams: [stream] });
    expect(onStreamCallCount).toBe(1);
    expect(video.srcObject).toBe(stream);

    peer.ontrack?.({ streams: [stream] });
    expect(onStreamCallCount).toBe(1);
  });
});
