import {
  discoverIceServers,
  enableStereoOpus,
  generateSdpFragment,
  parseIceServers,
  parseOffer,
} from './whep';

/**
 * The relay is not a convenience here.
 *
 * Every candidate the media server offers is a pod address. An unsplit
 * instance adds the one public address its UDP load balancer fronts; a read
 * replica has nothing but the pod. So a browser that does not use the relay
 * the server names has nothing it can pair with, the connection never forms,
 * and the card silently drops to HLS -- which is what it did for as long as
 * this client configured a public STUN server and ignored the Link headers.
 */
describe('parseIceServers', () => {
  const TURN =
    '<turn:turn.example:3478?transport=tcp>; rel="ice-server"; username="media"; ' +
    'credential="s3cr3t"; credential-type="password"';

  it('takes the URI, the username and the credential', () => {
    expect(parseIceServers(TURN)).toEqual([
      { urls: 'turn:turn.example:3478?transport=tcp', username: 'media', credential: 's3cr3t' },
    ]);
  });

  it('keeps the transport, which decides whether an allocation is possible', () => {
    // The load balancer in front of the relay on one cluster carries a TCP
    // listener and nothing else. Dropping the query would send the client to
    // a port nothing answers on.
    expect(parseIceServers(TURN)[0].urls).toContain('?transport=tcp');
  });

  it('splits several servers without splitting a URI that carries a comma', () => {
    const header = `${TURN}, <stun:stun.example:3478>; rel="ice-server"`;
    const servers = parseIceServers(header);

    expect(servers.length).toBe(2);
    expect(servers[1]).toEqual({ urls: 'stun:stun.example:3478' });
  });

  it('ignores a Link that is not an ice-server', () => {
    expect(parseIceServers('<https://example/doc>; rel="describedby"')).toEqual([]);
  });
});

describe('discoverIceServers', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('asks the WHEP endpoint with OPTIONS', async () => {
    // WHEP puts the servers on OPTIONS so a client can build its connection
    // before it has an offer to send. The POST repeats them, by which point
    // the connection exists and iceServers can no longer be set.
    let method: string | undefined;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      method = init.method;
      return Promise.resolve(
        new Response(null, {
          status: 204,
          headers: {
            Link: '<turn:turn.example:3478?transport=tcp>; rel="ice-server"; username="media"; credential="p"',
          },
        }),
      );
    }) as unknown as typeof fetch;

    const servers = await discoverIceServers('preview-x');

    expect(method).toBe('OPTIONS');
    expect(servers[0].urls).toBe('turn:turn.example:3478?transport=tcp');
  });

  it('answers with none when the server names none', async () => {
    // Host candidates alone still connect wherever the client shares a
    // network with the server, so this is not a reason to give up on WHEP.
    globalThis.fetch = (() =>
      Promise.resolve(new Response(null, { status: 204 }))) as unknown as typeof fetch;

    expect(await discoverIceServers('preview-x')).toEqual([]);
  });

  it('answers with none when the preflight fails', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;

    expect(await discoverIceServers('preview-x')).toEqual([]);
  });
});

/**
 * Trickle ICE is what lets the offer go before gathering finishes. On a
 * relay-only path -- which a read replica always is, having nothing but a pod
 * address to offer -- gathering is the whole TURN exchange, and paying for it
 * before the POST is seconds the connection never gets back.
 */
describe('parseOffer', () => {
  const SDP = [
    'v=0',
    'a=ice-ufrag:F7gI',
    'a=ice-pwd:x9cml/YzichV2+XlhiMu8g',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'a=mid:0',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    'a=mid:1',
    '',
  ].join('\r\n');

  it('takes the credentials the server matches a candidate against', () => {
    const offer = parseOffer(SDP);
    expect(offer.iceUfrag).toBe('F7gI');
    expect(offer.icePwd).toBe('x9cml/YzichV2+XlhiMu8g');
  });

  it('keeps the media lines in order, because the index is the mid', () => {
    expect(parseOffer(SDP).medias).toEqual([
      'video 9 UDP/TLS/RTP/SAVPF 96',
      'audio 9 UDP/TLS/RTP/SAVPF 111',
    ]);
  });

  it('keeps the first credentials, not the last', () => {
    // Per-media credentials appear after the session ones; taking the last
    // would send the server a ufrag it is not matching the session on.
    const offer = parseOffer(`${SDP}a=ice-ufrag:later\r\n`);
    expect(offer.iceUfrag).toBe('F7gI');
  });
});

describe('generateSdpFragment', () => {
  const OFFER = {
    iceUfrag: 'F7gI',
    icePwd: 'pw',
    medias: ['video 9 UDP/TLS/RTP/SAVPF 96', 'audio 9 UDP/TLS/RTP/SAVPF 111'],
  };
  const candidate = (sdpMLineIndex: number, text: string) =>
    ({ candidate: text, sdpMLineIndex }) as RTCIceCandidate;

  it('names the credentials and puts each candidate under its own mid', () => {
    const frag = generateSdpFragment(OFFER, [
      candidate(0, 'candidate:1 1 udp 1 10.0.0.1 1 typ host'),
      candidate(1, 'candidate:2 1 udp 1 10.0.0.2 2 typ host'),
    ]);

    expect(frag).toBe(
      'a=ice-ufrag:F7gI\r\na=ice-pwd:pw\r\n' +
        'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:0\r\n' +
        'a=candidate:1 1 udp 1 10.0.0.1 1 typ host\r\n' +
        'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=mid:1\r\n' +
        'a=candidate:2 1 udp 1 10.0.0.2 2 typ host\r\n',
    );
  });

  it('leaves out a medium no candidate belongs to', () => {
    const frag = generateSdpFragment(OFFER, [
      candidate(1, 'candidate:2 1 udp 1 10.0.0.2 2 typ host'),
    ]);
    expect(frag).not.toContain('m=video');
    expect(frag).toContain('m=audio');
  });

  it('drops a candidate with no media index, which names nothing to place it', () => {
    const orphan = { candidate: 'candidate:9', sdpMLineIndex: null } as unknown as RTCIceCandidate;
    expect(generateSdpFragment(OFFER, [orphan])).toBe('a=ice-ufrag:F7gI\r\na=ice-pwd:pw\r\n');
  });
});

/**
 * RFC 7587 defaults an offer to mono, so a browser that says nothing is asking
 * the server to downmix. An audio preview exists to hear a stereo pair of a
 * flow's channels, which is precisely what that throws away.
 */
describe('enableStereoOpus', () => {
  const sdp = (fmtp: string) =>
    ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', fmtp, ''].join('\r\n');

  it('asks for stereo both ways', () => {
    const out = enableStereoOpus(sdp('a=fmtp:111 minptime=10;useinbandfec=1'));
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1');
  });

  it('does not repeat what is already asked for', () => {
    const out = enableStereoOpus(sdp('a=fmtp:111 stereo=1;sprop-stereo=1'));
    expect(out.match(/stereo=1/g)).toHaveLength(2);
  });

  it("leaves another payload's parameters alone", () => {
    const out = enableStereoOpus(
      [
        'v=0',
        'm=audio 9 UDP/TLS/RTP/SAVPF 111 8',
        'a=rtpmap:111 opus/48000/2',
        'a=fmtp:8 x=1',
        '',
      ].join('\r\n'),
    );
    expect(out).toContain('a=fmtp:8 x=1');
  });

  it('passes an offer with no audio through unchanged', () => {
    const video = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 H264/90000', ''].join(
      '\r\n',
    );
    expect(enableStereoOpus(video)).toBe(video);
  });
});
