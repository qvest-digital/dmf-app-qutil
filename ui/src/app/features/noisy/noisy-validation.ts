import {
  NoisyPairRequest,
  NoisyRequest,
  NoisyResponse,
  NoisyShared,
  NoisySide,
} from '../../core/api/models';

/**
 * The form's copy of the aggregator's rules.
 *
 * charts/qutil/files/aggregator.py's _validate_noisy is the authority: the
 * strings here are copied from it word for word, so an operator hears the same
 * sentence before and after a round trip. The role, opt-in and expiry sets
 * arrive with /api/noisy rather than being repeated here.
 */

const NODE_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
const NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const CPU_RE = /^([0-9]+)m$|^([0-9]+)(\.[0-9]{1,3})?$/;
const MEMORY_RE = /^[0-9]+(Ki|Mi|Gi)$/;
const STORAGE_RE = /^[0-9]+(Mi|Gi)$/;
const DURATION_RE = /^(?:([0-9]+)h)?(?:([0-9]+)m)?(?:([0-9]+)s)?$/;
const NETWORKS_RE = /^[a-z0-9]([-a-z0-9./@,]*[a-z0-9])?$/;
const RDMA_DEVICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_CPU_MILLI = 32000;
const MAX_MEMORY_GI = 64;
const MAX_STORAGE_GI = 500;
const MAX_DURATION = 7200;
const UNITS: Record<string, number> = { Ki: 1 / (1 << 20), Mi: 1 / 1024, Gi: 1 };

function list(values: readonly string[]): string {
  return values.join(', ');
}

function gibibytes(quantity: string): number {
  const unit = quantity.slice(-2);
  return Number(quantity.slice(0, -2)) * (UNITS[unit] ?? 0);
}

function cpuMilli(quantity: string): number | null {
  const m = CPU_RE.exec(quantity);
  if (!m) return null;
  if (m[1] !== undefined) return Number(m[1]);
  return Number(m[2]) * 1000 + Number(((m[3] ?? '.').slice(1) + '000').slice(0, 3));
}

export function durationSeconds(text: string): number | null {
  const m = DURATION_RE.exec(text);
  if (!text || !m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

/** placement and resources: what differs between a pair's two claims. */
export function validateSide(side: NoisySide): string | null {
  const node = side.placement?.nodeName ?? '';
  const victim = side.placement?.victim ?? '';
  if (node && victim) return 'placement takes a node or a victim, not both';
  if (node && (node.length > 253 || !NODE_RE.test(node))) {
    return (
      "node must be a Kubernetes node name: lowercase letters, digits, '-' and '.', " +
      'at most 253 characters'
    );
  }
  if (victim && (victim.length > 53 || !NAME_RE.test(victim))) {
    return 'victim must be the name of a claim';
  }
  const requests = side.resources?.requests ?? {};
  if (requests.cpu !== undefined) {
    const milli = cpuMilli(requests.cpu);
    if (!milli || milli > MAX_CPU_MILLI) {
      return `cpu must be a quantity such as 500m or 2, at most ${MAX_CPU_MILLI / 1000} cores`;
    }
  }
  if (requests.memory !== undefined) {
    const gi = MEMORY_RE.test(requests.memory) ? gibibytes(requests.memory) : 0;
    if (!(gi > 0 && gi <= MAX_MEMORY_GI)) {
      return `memory must be a quantity such as 512Mi or 2Gi, at most ${MAX_MEMORY_GI}Gi`;
    }
  }
  return null;
}

/** Everything a pair's two claims share. */
export function validateShared(req: NoisyShared, limits: NoisyResponse | null): string | null {
  const ttls = limits?.ttls ?? [];
  if (ttls.length && !ttls.includes(req.ttl)) return `expiry must be one of ${list(ttls)}`;
  const networks = req.fabric?.networks ?? '';
  if (networks && (networks.length > 253 || !NETWORKS_RE.test(networks))) {
    return 'fabric.networks must be a network attachment such as fabric/roce';
  }
  if (networks && req.fabric?.hostNetwork) return 'fabric takes networks or hostNetwork, not both';
  const device = req.network?.rdmaDevice ?? '';
  if (device && !RDMA_DEVICE_RE.test(device)) {
    return 'rdmaDevice must be a verbs device name such as mlx5_0';
  }
  const gid = req.network?.rdmaGidIndex;
  if (gid !== undefined && (!Number.isInteger(gid) || gid < 0 || gid > 255)) {
    return 'rdmaGidIndex must be between 0 and 255';
  }
  const seconds = durationSeconds(req.limits.maxDuration);
  if (!seconds || seconds > MAX_DURATION) {
    return 'maxDuration must be a duration such as 15m or 1h30m, at most 2h';
  }
  const optIns = limits?.optIns ?? [];
  if (
    (optIns.length && !req.limits.optIns.every((o) => optIns.includes(o))) ||
    new Set(req.limits.optIns).size !== req.limits.optIns.length
  ) {
    return `optIns must be a subset of ${list(optIns)}`;
  }
  return null;
}

/** The first thing wrong with a booking of one claim, or null. */
export function validateNoisy(req: NoisyRequest, limits: NoisyResponse | null): string | null {
  const roles = limits?.roles ?? [];
  if (roles.length && !roles.includes(req.role)) return `role must be one of ${list(roles)}`;
  if (req.role === 'sender' && !req.peer) return 'a sender needs the sink it sends to';
  if (req.role !== 'sender' && req.peer) return 'only a sender takes a sink';
  const size = req.storage?.size;
  if (size !== undefined) {
    const gi = STORAGE_RE.test(size) ? gibibytes(size) : 0;
    if (!(gi > 0 && gi <= MAX_STORAGE_GI)) {
      return `storage size must be a quantity such as 20Gi, at most ${MAX_STORAGE_GI}Gi`;
    }
  }
  return validateSide(req) ?? validateShared(req, limits);
}

/** The first thing wrong with a booking of a sink and its sender, or null. */
export function validateNoisyPair(
  req: NoisyPairRequest,
  limits: NoisyResponse | null,
): string | null {
  for (const side of ['sink', 'sender'] as const) {
    const bad = validateSide(req[side]);
    if (bad) return `${side}: ${bad}`;
  }
  return validateShared(req, limits);
}
