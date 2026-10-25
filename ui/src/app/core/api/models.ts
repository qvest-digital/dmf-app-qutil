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
  /** The spec generation it was written for, where the resource records one. */
  observedGeneration?: number | null;
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

/**
 * One MxlFlowRedundancySet: an output flow served from several member flows,
 * switching between them per grain wherever one fails to deliver.
 */
export interface RedundancySet {
  name: string;
  /** The MxlDomain of the output; null is the primary domain. */
  domain?: string | null;
  /** 'Ordered' | 'FirstArrival'. */
  preference?: string | null;
  granularity?: string | null;
  skewBudget?: string | null;
  generation?: number | null;
  observedGeneration?: number | null;
  /** Where a reader wants the output, which is where it is merged. */
  nodes?: string[];
  /** Member MxlFlow names, in order of preference: `<domain>.<id>` outside
   *  the primary domain, the bare id in it. */
  members: string[];
  /** Whether the members can be merged at all. */
  valid?: FlowCondition | null;
  /** Whether every member is produced in the output's geometry; a False one
   *  names the members the output is served without. */
  membersReady?: FlowCondition | null;
  /**
   * The output as an inventory row, its id named like a member. It has no
   * MxlFlow: its media columns are the first member's that has one, its
   * locations the nodes it is wanted on, and it never has an origin.
   */
  output: OperatorFlow;
}

export interface OperatorFlowsResponse {
  flows: OperatorFlow[];
  sets?: RedundancySet[];
  /** Why the sets could not be listed; the flows are still current. */
  setsError?: string | null;
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

/** What the aggregator reports about a preview path's readiness. */
export interface PreviewStatus {
  /** Whether the path's source has opened the flow and is carrying media. */
  running?: boolean;
  /** What the path publishes, e.g. ["H264"] or ["Opus"]. */
  tracks?: string[];
  /** The flow's channel count, which is not what is published: see `selected`. */
  channels?: number;
  /**
   * The 1-based source channels being published as stereo. A path configured
   * without a pair takes the flow's first, so a caller must tolerate this
   * missing rather than assume [1, 2].
   */
  selected?: number[];
  error?: string;
}

// ── /api/generators ─────────────────────────────────────────────────────────

/** What the form sends. The aggregator translates these into claim parameters:
 *  no browser names a parameter key, because nothing validates one. */
/** Readers to book for a generator: each holds all its flows open on a node. */
export interface ReaderRequest {
  count: number;
  /** Node name to pin every reader to. Empty leaves placement to the scheduler. */
  node: string;
  /** libmxl-fabrics provider the receiver asks for: one of the server's list. */
  provider: string;
}

/** Readers of flows chosen by id, whoever writes them. */
export interface FlowReaderRequest extends ReaderRequest {
  /** Names the reader claims. */
  label: string;
  flows: string[];
  /** '1h' | '8h' | '24h' | 'none', as the server's list gives them. */
  ttl: string;
}

export interface GeneratorRequest {
  label: string;
  /** '1h' | '8h' | '24h' | 'none', as the server's list gives them. */
  ttl: string;
  /** Writers to book. Copies after the first get flow ids minted by the server. */
  count: number;
  /** Node name to pin every copy to. Empty leaves placement to the scheduler. */
  node: string;
  /** Readers booked for every copy. A count of 0 books none. */
  readers: ReaderRequest;
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

/** One reader of a generator's flows, as its claim reports itself. */
export interface GeneratorReader {
  name: string;
  generator?: string | null;
  phase?: string | null;
  ready?: boolean | null;
  deleting?: boolean;
  /** The binder's condition: whether the reader's workload serves at all. */
  reachable?: FlowCondition | null;
  /**
   * Whether every flow it reads had a read land within the last second, as the
   * reader's own endpoint answers. Null until that can be asked.
   */
  delivering?: boolean | null;
  node?: string | null;
  provider?: string | null;
  flows?: string[];
  created?: string | null;
  /** Its ring page, set only while the claim is live and the page answers. */
  ringUrl?: string | null;
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
  /** The node the booking pinned the writer to, or null when it pinned none. */
  node?: string | null;
  readers?: GeneratorReader[];
  /** Its ring page, set only while the claim is live and the page answers. */
  ringUrl?: string | null;
  video?: GeneratorVideo | null;
  audio?: GeneratorAudio | null;
}

/** The page's whole state: what is booked, and what the server will accept. */
/**
 * One claim the Bookings page created. Unlike a generator this carries no shape
 * of its own: the class decides what the parameters meant, and the page only
 * ever reads back what the claim reports.
 */
export interface Booking {
  name: string;
  className?: string | null;
  created?: string | null;
  /** Planned | Pending | Bound | Expired | Released | Failed. */
  phase?: string | null;
  ready?: boolean | null;
  /** Published by the claim once bound. A writer publishes none. */
  endpoints?: { name: string; url: string }[];
  /** Any *_output.id the parameters carried, so a booked flow can be spotted. */
  flowIds?: string[];
}

export interface BookingsResponse {
  namespace: string;
  enabled: boolean;
  max: number;
  bookings: Booking[];
  error?: string | null;
}

export interface GeneratorsResponse {
  namespace: string;
  className: string;
  enabled: boolean;
  /** Most copies one submission may book, and most readers one request may. */
  maxCopies: number;
  readerClass?: string;
  /** The domain history the server sizes a writer's memory by; 0 means 10 grains. */
  historySeconds?: number;
  /** libmxl-fabrics providers a reader may ask for. */
  providers?: string[];
  ttls: string[];
  patterns: string[];
  /** Patterns that stall the test source above 1296x720. */
  animated: string[];
  frameSizes: { width: number; height: number }[];
  grainRates: { numerator: number; denominator: number }[];
  sampleRates: number[];
  generators: Generator[];
  /** Readers of chosen flows, which belong to no generator. */
  readers?: GeneratorReader[];
  /** Readers whose generator is gone, so they can still be released. */
  orphanReaders?: GeneratorReader[];
  error?: string | null;
}

/**
 * What one submission booked. `error` is set when a later copy failed after
 * earlier ones were created: those run, so they are returned all the same.
 */
export interface GeneratorBatch {
  generators: Generator[];
  error?: string | null;
}

/** What one reader request booked, with the first failure if it stopped short. */
export interface ReaderBatch {
  readers: GeneratorReader[];
  error?: string | null;
}

/** Two flow ids nothing holds yet. Minted server-side: uniqueness can only be
 *  judged where the index is. */
export interface FlowIds {
  videoFlowId: string;
  audioFlowId: string;
}

// ── GET /api/services ───────────────────────────────────────────────────────

/** One address a booked function publishes on its handle. */
export interface ServiceEndpoint {
  name: string;
  /** In-cluster Service address. Always present, never reachable from a browser. */
  url: string;
  api?: string;
  /**
   * The address a person opens, read off the resource the function's chart
   * applied. Absent for most classes: a class publishes one only where it
   * names that resource, so absence means "there is none", not "unknown".
   */
  externalUrl?: string;
}

export interface BookedService {
  claim: string;
  endpoints: ServiceEndpoint[];
}

export interface ServicesResponse {
  services: BookedService[];
}

// ── GET /api/grains, /api/grain, /api/samples ───────────────────────────────
//
// What the ring actually holds, as opposed to what the media server makes of
// it. Served by the grain reader: a media function, because reading a grain
// needs libmxl and the node's MXL domain.

/** One window of an audio ring. Audio is continuous, so a snapshot is a span
 *  of samples rather than a grain. */
export interface SampleWindow {
  index: number;
  count: number;
}

/** The ring behind one flow: how many entries it holds and which are still in
 *  it. A discrete flow reports grainCount, a continuous one reports windows. */
export interface GrainRing {
  flow: string;
  format: string;
  grainRate: { num: number; den: number };
  /** Discrete flows only. The number of buttons. */
  grainCount?: number;
  /** Newest committed index, and the oldest the ring still holds. */
  headIndex: number;
  firstIndex: number;
  width?: number;
  height?: number;
  mediaType?: string;
  /** Continuous flows only. */
  channelCount?: number;
  bufferLength?: number;
  sampleRate?: number;
  windows?: SampleWindow[];
  error?: string | null;
}

/** One addressed grain, without its payload. */
export interface GrainMeta {
  flow: string;
  index: number;
  flags: number;
  grainSize: number;
  totalSlices: number;
  validSlices: number;
  complete: boolean;
  /** The writer committed this grain but marked its payload untrustworthy. */
  invalid: boolean;
  bytes: number;
  width?: number;
  height?: number;
  mediaType?: string;
  /** v210 pads each row to 128 bytes, so this is not width * 8 / 3. */
  stride?: number;
  error?: string | null;
}

/** One channel of an audio window: what a meter needs, plus points to draw. */
export interface ChannelStats {
  channel: number;
  peak: number;
  rms: number;
  min: number;
  /** Decimated for drawing, not the whole window. */
  samples: number[];
}

/** A copy of the whole ring, taken at one moment. What the button row browses. */
export interface RingCapture {
  taken: string;
  flow: string;
  info: GrainRing;
  /** Discrete flows only; audio carries its windows on info instead. */
  grains?: GrainMeta[];
  error?: string | null;
}

export interface AudioSnapshot {
  flow: string;
  index: number;
  count: number;
  sampleRate: number;
  channels: ChannelStats[];
  error?: string | null;
}
