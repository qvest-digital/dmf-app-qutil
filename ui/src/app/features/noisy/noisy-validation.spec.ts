import { NoisyPairRequest, NoisyRequest, NoisyResponse } from '../../core/api/models';
import { validateNoisy, validateNoisyPair } from './noisy-validation';

const LIMITS: NoisyResponse = {
  namespace: 'production-demo-app',
  className: 'noisy-neighbour',
  enabled: true,
  max: 4,
  roles: ['aggressor', 'sender', 'sink'],
  optIns: ['rdma-lossless', 'multicast', 'line-rate'],
  ttls: ['1h', '8h', '24h', 'none'],
  nodes: ['worker-1'],
  victims: ['writer-mxl-1'],
  noisy: [],
};

function request(over: Partial<NoisyRequest> = {}): NoisyRequest {
  return {
    role: 'aggressor',
    label: '',
    ttl: '1h',
    limits: { maxDuration: '15m', optIns: [] },
    ingress: { httproute: { enabled: true } },
    ...over,
  };
}

/**
 * The server is the authority; this only spares a round trip, so each message
 * has to be the aggregator's own sentence.
 */
describe('validateNoisy', () => {
  it('accepts a full aggressor', () => {
    expect(
      validateNoisy(
        request({
          placement: { victim: 'writer-mxl-1' },
          resources: { requests: { cpu: '1500m', memory: '2Gi' } },
          storage: { enabled: true, size: '20Gi' },
          limits: { maxDuration: '1h30m', optIns: ['line-rate'] },
        }),
        LIMITS,
      ),
    ).toBeNull();
  });

  it('refuses a role the server does not offer', () => {
    expect(validateNoisy(request({ role: 'victim' }), LIMITS)).toContain('role must be one of');
  });

  it('places on a node or beside a victim, not both', () => {
    expect(
      validateNoisy(request({ placement: { nodeName: 'worker-1', victim: 'x' } }), LIMITS),
    ).toBe('placement takes a node or a victim, not both');
    expect(validateNoisy(request({ placement: { nodeName: 'Worker_1' } }), LIMITS)).toContain(
      'node must be a Kubernetes node name',
    );
  });

  it('bounds cpu, memory and storage', () => {
    for (const cpu of ['0', '33', '40000m', '1.2345', '2 cores']) {
      expect(validateNoisy(request({ resources: { requests: { cpu } } }), LIMITS)).toContain(
        'cpu must be a quantity',
      );
    }
    for (const memory of ['65Gi', '1G', '0Mi']) {
      expect(validateNoisy(request({ resources: { requests: { memory } } }), LIMITS)).toContain(
        'memory must be a quantity',
      );
    }
    expect(validateNoisy(request({ storage: { enabled: true, size: '1Ti' } }), LIMITS)).toContain(
      'storage size must be',
    );
  });

  it('bounds the engine timeout at two hours', () => {
    for (const maxDuration of ['2h1m', '3h', '0m', '', '15 minutes']) {
      expect(validateNoisy(request({ limits: { maxDuration, optIns: [] } }), LIMITS)).toContain(
        'maxDuration must be',
      );
    }
    expect(
      validateNoisy(request({ limits: { maxDuration: '2h', optIns: [] } }), LIMITS),
    ).toBeNull();
  });

  it('takes only the opt-ins the server lists, once each', () => {
    expect(
      validateNoisy(request({ limits: { maxDuration: '15m', optIns: ['unbounded'] } }), LIMITS),
    ).toContain('optIns must be a subset');
    expect(
      validateNoisy(
        request({ limits: { maxDuration: '15m', optIns: ['multicast', 'multicast'] } }),
        LIMITS,
      ),
    ).toContain('optIns must be a subset');
  });

  it('keeps the fabric attachment exclusive and the GID index in range', () => {
    expect(
      validateNoisy(
        request({
          role: 'sink',
          fabric: { enabled: true, networks: 'fabric/roce', hostNetwork: true },
        }),
        LIMITS,
      ),
    ).toBe('fabric takes networks or hostNetwork, not both');
    expect(validateNoisy(request({ role: 'sink', network: { rdmaGidIndex: 256 } }), LIMITS)).toBe(
      'rdmaGidIndex must be between 0 and 255',
    );
  });

  it('needs a sink for a sender and refuses one for anything else', () => {
    expect(validateNoisy(request({ role: 'sender' }), LIMITS)).toBe(
      'a sender needs the sink it sends to',
    );
    expect(validateNoisy(request({ role: 'sink', peer: 'noisy-s-0001' }), LIMITS)).toBe(
      'only a sender takes a sink',
    );
    expect(validateNoisy(request({ role: 'sender', peer: 'noisy-s-0001' }), LIMITS)).toBeNull();
  });
});

describe('validateNoisyPair', () => {
  function pair(over: Partial<NoisyPairRequest> = {}): NoisyPairRequest {
    return {
      label: '',
      ttl: '1h',
      limits: { maxDuration: '15m', optIns: [] },
      ingress: { httproute: { enabled: true } },
      sink: {},
      sender: {},
      ...over,
    };
  }

  it('names the side that is wrong', () => {
    expect(validateNoisyPair(pair({ sender: { placement: { nodeName: '-x' } } }), LIMITS)).toMatch(
      /^sender: node must be/,
    );
  });

  it('checks what both sides share', () => {
    expect(
      validateNoisyPair(pair({ limits: { maxDuration: '3h', optIns: [] } }), LIMITS),
    ).toContain('maxDuration must be');
    expect(validateNoisyPair(pair(), LIMITS)).toBeNull();
  });
});
