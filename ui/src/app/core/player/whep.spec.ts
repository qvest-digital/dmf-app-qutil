import { parseIceServers, discoverIceServers } from './whep';

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
