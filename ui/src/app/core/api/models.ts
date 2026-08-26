/**
 * Payload shapes served by the demo-metrics aggregator (k8s/metrics/aggregator.py).
 *
 * Everything here is what the aggregator actually emits, not what would be
 * convenient: the Kubernetes objects it reads are sparse, so almost every field
 * is nullable and the UI is expected to say "--" rather than assume a value.
 */

// ── GET /api/flows ──────────────────────────────────────────────────────────

export interface WriterInfo {
  pod?: string | null;
  node?: string | null;
  phase?: string | null;
  ready?: boolean | null;
  restarts?: number | null;
  started?: string | null;
  image?: string | null;
  pattern?: string | null;
  overlay?: string | null;
  overlayFormat?: string | null;
}

export interface CompositorInfo {
  /** Whether the tile is considered live; drives the badge and the row dot. */
  live?: boolean | null;
  fps?: number | null;
  mbps?: number | null;
  pushed?: number | null;
  missed?: number | null;
  /** null when the compositor's stats server could not be reached at all. */
  reading?: boolean | null;
  /** false when fps/mbps are format arithmetic rather than a measurement. */
  measured?: boolean;
  source?: string | null;
}

export interface MediaInfo {
  mediaType?: string | null;
  width?: number | null;
  height?: number | null;
  bitDepth?: number | null;
  colorspace?: string | null;
  grainRate?: string | null;
  fps?: number | null;
  grainBytes?: number | null;
  nominalMbps?: number | null;
}

export interface ReceiverInfo {
  name?: string | null;
  provider?: string | null;
  phase?: string | null;
  boundMirror?: string | null;
}

export interface MirrorInfo {
  name: string;
  phase?: string | null;
  sourceNode?: string | null;
  provider?: string | null;
}

export interface FlowLocation {
  node?: string | null;
  phase?: string | null;
}

export interface FlowCrInfo {
  /**
   * The raw condition status string off the MxlFlow CR — 'True' | 'False' | null,
   * NOT a boolean. /api/operator-flows normalises this; /api/flows does not.
   */
  originFresh?: string | null;
  originReason?: string | null;
  locations?: FlowLocation[];
}

/**
 * The nested objects are `| null` rather than merely optional: the aggregator
 * emits an explicit null for anything it could not resolve — no writer pod, no
 * MxlFlow CR, no compositor stats — rather than omitting the key.
 */
export interface Flow {
  n: number;
  label: string;
  uuid: string;
  compositor?: CompositorInfo | null;
  media?: MediaInfo | null;
  writer?: WriterInfo | null;
  receiver?: ReceiverInfo | null;
  mirrors?: MirrorInfo[] | null;
  flow?: FlowCrInfo | null;
}

export interface Gateway {
  name: string;
  node?: string | null;
  phase?: string | null;
  ready?: boolean | null;
  restarts?: number | null;
  image?: string | null;
}

export interface FlowsResponse {
  provider: string;
  grid: { cols: number; rows: number };
  grainBytes: number;
  gateways: Gateway[];
  flows: Flow[];
}

// ── GET /api/operator-flows ─────────────────────────────────────────────────

export interface OperatorLocation extends FlowLocation {
  observedAge?: number | null;
}

export interface FlowCondition {
  type?: string | null;
  status?: string | null;
  reason?: string | null;
  message?: string | null;
  age?: number | null;
}

export interface DetailReceiver {
  name: string;
  namespace?: string | null;
  provider?: string | null;
  phase?: string | null;
  pod?: string | null;
  boundMirror?: string | null;
}

export interface DetailMirror {
  name: string;
  namespace?: string | null;
  sourceNode?: string | null;
  targetNode?: string | null;
  provider?: string | null;
  phase?: string | null;
  attempts?: number | null;
  lastError?: string | null;
  grainAge?: number | null;
  requestor?: string | null;
  conditions?: FlowCondition[];
}

export interface OperatorMedia {
  mediaType?: string | null;
  colorspace?: string | null;
  interlaceMode?: string | null;
  width?: number | null;
  height?: number | null;
  bitDepth?: number | null;
  channels?: number | null;
  sampleRate?: string | null;
  grainRate?: string | null;
  fps?: number | null;
  grainBytes?: number | null;
  nominalMbps?: number | null;
  components?: string[];
}

export interface OperatorFlowDetail {
  created?: string | null;
  createdAge?: number | null;
  description?: string | null;
  media?: OperatorMedia;
  parents?: string[];
  tags?: Record<string, string | string[]>;
  conditions?: FlowCondition[];
  receivers?: DetailReceiver[];
  mirrors?: DetailMirror[];
}

export interface OperatorFlow {
  id: string;
  label: string;
  description?: string | null;
  /** 'video' | 'audio' | 'data' | … — the NMOS format URN's last segment. */
  format?: string | null;
  mediaType?: string | null;
  resolution?: string | null;
  rate?: string | null;
  channels?: number | null;
  colorspace?: string | null;
  grouphint?: string | null;
  locations?: OperatorLocation[] | null;
  detail?: OperatorFlowDetail | null;
  /**
   * Genuinely three-state: true = an origin Lease is being renewed, false = a
   * node claims Origin but its Lease lapsed, null = nothing claims Origin
   * (mirror-only, or just published). null is unknown, not broken.
   */
  originFresh?: boolean | null;
  originReason?: string | null;
  originNode?: string | null;
  originAge?: number | null;
}

export interface OperatorFlowsResponse {
  flows: OperatorFlow[];
}

// ── /api/preview/<uuid> ─────────────────────────────────────────────────────

export interface PreviewSession {
  path: string;
  hls: string;
  whep: string;
  format: 'video' | 'audio' | 'data';
  /** The audio flow carried alongside the video, on a joined path only. */
  audio?: string;
  /** Where to poll decoded grains. Data flows only: nothing plays them. */
  anc?: string;
  error?: string;
}

/** One RFC-8331 packet of an ANC grain, as the reader decodes it. */
export interface AncElement {
  line: number;
  did: number;
  sdid: number;
  dataCount: number;
  /** What the DID/SDID pair is registered as, or that it is not. */
  description: string;
  /** User data words, low 8 bits of each 10-bit word. */
  udw: number[];
  /**
   * Whether every word's ANC parity bit matched its data byte. False means the
   * words were read out of step with the packing, so the bytes are not the
   * sender's -- worth saying rather than decoding anyway.
   */
  parityOk?: boolean;
}

/** The latest grain of an ANC data flow. */
export interface AncGrain {
  flow: string;
  index?: number;
  flags?: number;
  grainSize?: number;
  validSlices?: number;
  totalSlices?: number;
  rfc8331Length?: number;
  /**
   * ANC_Count as the grain header declares it, which the ST 2110-40 senders on
   * this fabric leave at zero even while sending packets. `ancCount` is what the
   * payload actually held, so the two disagreeing is worth showing.
   */
  declaredCount?: number;
  ancCount?: number;
  elements?: AncElement[];
  error?: string;
}

/** One entry of the audio-preview pod's /status, proxied verbatim. */
export interface PreviewStatus {
  flow?: string;
  running?: boolean;
  samples?: number;
  /** The flow's channel count, which is not what is published: see `selected`. */
  channels?: number;
  /**
   * The 1-based source channels on their way out as stereo, after clamping to
   * the flow's width. Absent from an audio-preview that predates the pair
   * selection, so a caller must tolerate it missing rather than assume [1, 2].
   */
  selected?: number[];
  /** dBFS per source channel, all of them, not only the published pair. */
  channelPeakDb?: number[];
  error?: string;
}

// ── /api/generators ─────────────────────────────────────────────────────────

/** What the form sends. The aggregator translates these into claim parameters:
 *  no browser names a parameter key, because nothing validates one. */
export interface GeneratorRequest {
  label: string;
  /** '1h' | '8h' | '24h' | 'none', as the server's list gives them. */
  ttl: string;
  video: {
    enabled: boolean;
    id: string;
    pattern: string;
    overlayText: string;
    frameWidth: number;
    frameHeight: number;
    grainRate: { numerator: number; denominator: number };
  };
  audio: {
    enabled: boolean;
    id: string;
    sampleRate: number;
    channelCount: number;
  };
}

export interface GeneratorVideo {
  id?: string | null;
  pattern?: string | null;
  overlayText?: string | null;
  frameWidth?: number | null;
  frameHeight?: number | null;
  /** Already formatted as numerator/denominator: it is read, not calculated. */
  grainRate?: string | null;
}

export interface GeneratorAudio {
  id?: string | null;
  sampleRate?: number | null;
  channelCount?: number | null;
}

/** One booked generator, as the claim reports itself. */
export interface Generator {
  name: string;
  namespace?: string | null;
  className?: string | null;
  /** Planned | Pending | Bound | Expired | Released | Failed. */
  phase?: string | null;
  ready?: boolean | null;
  /** The claim has a deletionTimestamp and is on its way out. */
  deleting?: boolean;
  /**
   * The binder's own condition. A writer publishes no endpoints, so this reason
   * (WaitingForProvisioner, WorkloadProgressing, ProvisionFailed) is the only
   * account of why a claim has not gone ready.
   */
  reachable?: FlowCondition | null;
  expiresAt?: string | null;
  created?: string | null;
  ageSeconds?: number | null;
  groupHint?: string | null;
  video?: GeneratorVideo | null;
  audio?: GeneratorAudio | null;
}

/** The page's whole state: what is booked, and what the server will accept. */
export interface GeneratorsResponse {
  namespace: string;
  className: string;
  enabled: boolean;
  max: number;
  ttls: string[];
  patterns: string[];
  /** Patterns that stall the test source above 1296x720. */
  animated: string[];
  frameSizes: { width: number; height: number }[];
  grainRates: { numerator: number; denominator: number }[];
  sampleRates: number[];
  generators: Generator[];
  error?: string | null;
}

/** Two flow ids nothing holds yet. Minted server-side: uniqueness can only be
 *  judged where the index is. */
export interface FlowIds {
  videoFlowId: string;
  audioFlowId: string;
}
