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

export interface Flow {
  n: number;
  label: string;
  uuid: string;
  compositor?: CompositorInfo;
  media?: MediaInfo;
  writer?: WriterInfo;
  receiver?: ReceiverInfo;
  mirrors?: MirrorInfo[];
  flow?: FlowCrInfo;
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
  locations?: OperatorLocation[];
  detail?: OperatorFlowDetail;
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

// ── GET /api/booking ────────────────────────────────────────────────────────

export type BookingPhase = 'booked' | 'deploying' | 'on-air' | 'post-roll' | 'reclaimed';

export interface BookingPod {
  name: string;
  phase?: string | null;
  node?: string | null;
  ageSeconds?: number | null;
  deleting?: boolean;
}

export interface BookingInstance {
  name: string;
  type?: string | null;
  instancePhase?: string | null;
  jobRef?: string | null;
  windowEnd?: string | null;
  replicas?: number | null;
  helmReady?: boolean;
  helmMessage?: string | null;
  /** Source count IS the template: 2 -> template-1, 3 -> template-2. */
  sources?: string[];
  readerFlow?: string | null;
  /** What the reader is on right now, vs. readerFlow which is the config. */
  liveReaderFlow?: string | null;
  outFlow?: string | null;
  pod?: BookingPod | null;
  phase?: BookingPhase | null;
}

export interface StoryBeat {
  at: string;
  kind: 'deploy' | 'live' | 'teardown';
  text: string;
}

export interface BookingResponse {
  namespace: string;
  instances: BookingInstance[];
  events: { at: string; reason?: string; object?: string; kind?: string; message?: string }[];
  story: StoryBeat[];
  error?: string;
}

// ── /api/preview/<uuid> ─────────────────────────────────────────────────────

export interface PreviewSession {
  path: string;
  hls: string;
  whep: string;
  format: 'video' | 'audio';
  error?: string;
}

/** One entry of the audio-preview pod's /status, proxied verbatim. */
export interface PreviewStatus {
  flow?: string;
  running?: boolean;
  samples?: number;
  channels?: number;
  error?: string;
}
