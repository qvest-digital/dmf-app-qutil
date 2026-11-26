import { GraphEnd, GraphSet, MxlGraph, SetCondition } from '../../core/api/models';

/** Layout constants, in drawing units. The diagram is drawn at these and
 *  scaled by the viewBox, so none of them are CSS. */
export const CARD_W = 188;
export const BOX_H = 46;
const ROW_H = 62;
export const HEAD_H = 34;
export const PAD = 14;
/** How far apart two lines run side by side. */
const LANE_GAP = 7;
/** The least room right of the cards in a node, where its local reads run. */
const MIN_LANE = 20;
/** The least room between two node boxes. */
const MIN_GAP = 48;
/** The room outside the first and last node box when no line runs there. */
const EDGE_GAP = 2;
/** Between the lowest line above the nodes and the node boxes. */
const BAND_MARGIN = 10;
/** How far apart the lines leaving or entering one card edge are. */
const PORT_GAP = 7;
export const ARROW = 7;
/** Half an arrowhead's height: two of them fit between neighbouring ports. */
const ARROW_HALF = 3;
const CORNER = 5;

/** The column for what no node claims. Empty because that is what the API
 *  reports when no pod matches a function, so placed and unplaced share one
 *  code path. */
export const NO_NODE = '';

export type CardKind = 'function' | 'member' | 'output';
export type WireState = 'ok' | 'pending' | 'broken';
/** A set's state adds degraded: served, but not from every member, or not
 *  on every node that wants it. */
export type SetState = WireState | 'degraded';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Card {
  readonly key: string;
  readonly kind: CardKind;
  readonly title: string;
  readonly sub: string;
  readonly tooltip: string;
  readonly node: string;
  /** A function that writes a flow is outlined as a writer. */
  writes: boolean;
  /** A set's own state, on member and output cards only. */
  readonly state: SetState | null;
  x: number;
  y: number;
  readonly w: number;
  readonly h: number;
}

export interface Wire {
  readonly key: string;
  readonly from: string;
  readonly to: string;
  /** A function reading a flow, or a member reaching a set's output. */
  readonly kind: 'read' | 'leg';
  /** Stays inside one node: read out of its shared memory. */
  readonly local: boolean;
  readonly state: WireState;
  readonly title: string;
  /** Grains per second of the flow the line carries, absent where the flow
   *  has no grain rate. */
  readonly rate?: number;
  /** Channel count of the audio flow the line carries, absent otherwise. */
  readonly channels?: number;
  /** The corners the line runs through, from the source card's edge to the
   *  base of the arrowhead. */
  readonly points: readonly Point[];
  readonly d: string;
  /** Where the arrowhead touches the target card's edge. */
  readonly tip: Point;
  /** +1 where the arrowhead points right, into a card's left edge; -1 where
   *  it points left, into a card's right edge. */
  readonly dir: 1 | -1;
  /** The arrowhead as polygon points. */
  readonly head: string;
}

export interface NodeBox {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FlowLayout {
  readonly nodes: readonly NodeBox[];
  readonly cards: readonly Card[];
  readonly wires: readonly Wire[];
  readonly w: number;
  readonly h: number;
}

/** Green while the set merges every member, degraded while it is served
 *  without one of them, which is what the set is for, or while a node that
 *  wants the output has no gateway up to merge it, broken once the operator
 *  says it cannot be merged, pending while it has said nothing current. An
 *  OutputReady the operator does not write, as an older mxl-k8s does not, is
 *  unknown and keeps a set green. */
export function setState(set: GraphSet): SetState {
  const valid = set.valid?.status;
  const ready = set.membersReady?.status;
  if (valid === 'False') return 'broken';
  if (ready === 'False' || set.outputReady?.status === 'False') return 'degraded';
  if (valid === 'True' && ready === 'True') return 'ok';
  return 'pending';
}

/** A leg's mirror phase as a line draws it. */
export function legState(phase: string): WireState {
  switch (phase) {
    case 'Local':
    case 'Ready':
      return 'ok';
    case 'Pending':
    case 'Materializing':
    case 'NoMirror':
    case 'Unknown':
      return 'pending';
    default:
      return 'broken';
  }
}

function conditionText(name: string, c: SetCondition | undefined): string {
  if (!c) return `${name}: not reported`;
  return `${name}: ${c.status}${c.reason ? ` (${c.reason})` : ''}${c.message ? ` - ${c.message}` : ''}`;
}

/** What the operator says of a set, short enough for a card. */
function verdict(set: GraphSet): string {
  if (set.valid?.status === 'False') return set.valid.reason ?? 'not valid';
  if (set.outputReady?.status === 'False') return set.outputReady.reason ?? 'gateway down';
  if (set.membersReady?.status === 'False') return set.membersReady.reason ?? 'members missing';
  if (setState(set) === 'ok') return `${set.members.length} members ready`;
  return 'no status yet';
}

function legText(phase: string): string {
  switch (phase) {
    case 'Local':
      return 'read on its own node, no mirror';
    case 'NoMirror':
      return 'no mirror yet';
    case 'NoOrigin':
      return 'nothing produces it';
    case 'Unknown':
      return 'mirror state unknown';
    default:
      return `mirror ${phase}`;
  }
}

interface Pending {
  key: string;
  from: string;
  to: string;
  kind: 'read' | 'leg';
  state: WireState;
  title: string;
  rate?: number;
  channels?: number;
}

interface Route {
  e: Pending;
  a: Card;
  b: Card;
  local: boolean;
  /** Not local: straight across the gap to the next node, or over the top. */
  direct: boolean;
  y1: number;
  y2: number;
  lane: number;
  rise: number;
  drop: number;
  band: number;
}

/**
 * The cluster's flows as a picture: every node a box, every function a card
 * inside the node it runs on, every read an arrow from the writer to the
 * reader. A redundancy set adds a card per member at the member's origin, a
 * card for its output on each node it is merged on, an arrow per leg from
 * each member into each output and one from the output to each reader.
 *
 * An arrow that stays inside a box is a read out of shared memory. One that
 * leaves it is carried across the fabric: it goes straight across the gap to
 * the next node, or over the top of every node in a band of its own, so no
 * arrow runs through a card it has nothing to do with. Every line has its own
 * port on each card edge and its own lane in each gap, so two lines never
 * share a path and neither hides the other.
 *
 * Every size is a constant here rather than a measurement, so the lines meet
 * the cards without reading the DOM.
 */
export function layoutFlows(graph: MxlGraph): FlowLayout {
  const cards = new Map<string, Card>();
  const card = (c: Omit<Card, 'x' | 'y' | 'w' | 'h'>): Card => {
    const found = cards.get(c.key);
    if (found) return found;
    const made: Card = { ...c, x: 0, y: 0, w: CARD_W, h: BOX_H };
    cards.set(c.key, made);
    return made;
  };
  // A function appears once per node however many flows it touches, and one
  // that writes anything is drawn as a writer. Claim names repeat across
  // productions, so a card is one production's function on one node: the
  // engines of a redundant booking are a card each.
  const fn = (end: GraphEnd, writes: boolean, node = end.node): Card => {
    const key = fnKey(end);
    const found = cards.get(key);
    if (found) {
      found.writes ||= writes;
      return found;
    }
    const cls = end.class ?? '';
    const where = end.production ? ` in ${end.production}` : '';
    return card({
      key,
      kind: 'function',
      title: end.function,
      sub: cls,
      tooltip: `${end.function} (${cls})${where} on ${shortNode(node || NO_NODE)}`,
      node: node || NO_NODE,
      writes,
      state: null,
    });
  };

  const pending: Pending[] = [];
  const rates = new Map(graph.flows.map((f) => [f.id, f.rate]));
  const channels = new Map(graph.flows.map((f) => [f.id, f.channels]));

  for (const f of graph.flows) {
    // A producer the API places on no node is drawn where its flow lives; a
    // consumer on no node goes to the column for what no node claims.
    if (f.producer) fn(f.producer, true, f.producer.node || f.originNode);
    for (const c of f.consumers) fn(c, false);
  }
  for (const f of graph.flows) {
    if (!f.producer) continue;
    const from = fnKey(f.producer);
    for (const c of f.consumers) {
      const to = fnKey(c);
      if (to === from) continue;
      pending.push({
        key: `read:${f.id}:${to}`,
        from,
        to,
        kind: 'read',
        // A remote reader whose node holds no copy yet is waiting on the gateway.
        state: c.local || c.mirrored ? 'ok' : 'pending',
        title: `${f.label} (${f.kind})`,
        rate: f.rate,
        channels: f.channels,
      });
    }
  }

  for (const set of graph.sets ?? []) {
    const state = setState(set);
    const status = [
      conditionText('Valid', set.valid),
      conditionText('MembersReady', set.membersReady),
      conditionText('OutputReady', set.outputReady),
    ].join('\n');
    set.members.forEach((m, i) => {
      const role = `member ${i + 1} of ${set.name}`;
      card({
        key: `member:${set.name}:${m.id}`,
        kind: 'member',
        title: m.label,
        sub: !m.exists
          ? `member ${i + 1} - no MxlFlow`
          : !m.originNode
            ? `member ${i + 1} - not produced`
            : `member ${i + 1}${m.producer ? ` - ${m.producer}` : ''}`,
        tooltip: `${m.label} (${m.id}), ${role}, ${
          m.originNode ? `written on ${shortNode(m.originNode)}` : 'written nowhere'
        }`,
        node: m.originNode || NO_NODE,
        writes: false,
        state: m.exists && m.originNode ? 'ok' : 'broken',
      });
    });

    // The output is merged where a reader asked for it; a reader the operator
    // has not caught up with yet still shows where it waits.
    const at = new Set<string>(set.nodes);
    for (const r of set.readers) at.add(r.node || NO_NODE);
    if (!at.size) at.add(NO_NODE);
    for (const node of at) {
      const merged = set.nodes.includes(node);
      const where = merged
        ? `merged on ${shortNode(node)}`
        : set.nodes.length
          ? `not merged here yet, merged on ${set.nodes.map(shortNode).join(', ')}`
          : 'merged on no node';
      card({
        key: `output:${set.name}:${node}`,
        kind: 'output',
        title: set.name,
        sub: merged
          ? `output - ${verdict(set)}`
          : set.nodes.length
            ? 'output - not merged here yet'
            : 'output - merged on no node',
        tooltip: `${set.name}: ${set.kind || 'flow'} ${set.output}, ${where}\n${status}`,
        node,
        writes: false,
        state,
      });
    }

    for (const leg of set.legs) {
      const member = set.members.find((m) => m.id === leg.member);
      pending.push({
        key: `leg:${set.name}:${leg.member}:${leg.node}`,
        from: `member:${set.name}:${leg.member}`,
        to: `output:${set.name}:${leg.node}`,
        kind: 'leg',
        state: legState(leg.phase),
        title: `${member?.label ?? leg.member} into ${set.name} on ${shortNode(leg.node)}: ${legText(leg.phase)}`,
        rate: rates.get(leg.member),
        channels: channels.get(leg.member),
      });
    }
    // The output runs at its members' rate where it has no MxlFlow of its own
    // in the list.
    const outputRate =
      rates.get(set.output) ??
      set.members.map((m) => rates.get(m.id)).find((rate) => rate !== undefined);
    const outputChannels =
      channels.get(set.output) ??
      set.members.map((m) => channels.get(m.id)).find((n) => n !== undefined);
    for (const r of set.readers) {
      const reader = fn(r, false);
      pending.push({
        key: `read:${set.output}:${reader.key}`,
        from: `output:${set.name}:${r.node || NO_NODE}`,
        to: reader.key,
        kind: 'read',
        state: set.nodes.includes(r.node ?? '') ? 'ok' : 'pending',
        title: `${set.name} (${set.kind || 'flow'}) output`,
        rate: outputRate,
        channels: outputChannels,
      });
    }
  }

  // Nodes left to right, the ones that write first: a flow is read from the
  // node that wrote it, so the picture reads the same way. What no node
  // claims gets a column of its own at the end.
  const all = [...cards.values()];
  const writers = new Set(
    all.filter((c) => (c.writes || c.kind === 'member') && c.node).map((c) => c.node),
  );
  const named = new Set([...graph.nodes, ...all.map((c) => c.node)].filter((n) => n));
  const columns = [...[...writers].sort(), ...[...named].filter((n) => !writers.has(n)).sort()];
  if (all.some((c) => c.node === NO_NODE)) columns.push(NO_NODE);
  const col = new Map(columns.map((n, i) => [n, i]));
  const colOf = (c: Card) => col.get(c.node) as number;

  // Within a node: writers, then a set's members, its outputs, then readers,
  // so a flow runs down the box the way it is passed on.
  const rank = (c: Card) => (c.kind === 'member' ? 1 : c.kind === 'output' ? 2 : c.writes ? 0 : 3);
  const rows = new Map<string, Card[]>(columns.map((n) => [n, []]));
  for (const c of [...cards.values()]) rows.get(c.node)!.push(c);
  for (const list of rows.values()) list.sort((a, b) => rank(a) - rank(b));

  const routes: Route[] = pending
    .filter((e) => cards.has(e.from) && cards.has(e.to))
    .map((e) => {
      const a = cards.get(e.from)!;
      const b = cards.get(e.to)!;
      const local = a.node === b.node && a.node !== NO_NODE;
      return {
        e,
        a,
        b,
        local,
        direct: !local && colOf(b) === colOf(a) + 1,
        y1: 0,
        y2: 0,
        lane: 0,
        rise: 0,
        drop: 0,
        band: 0,
      };
    });

  // Widths: a node grows with the local reads its lane carries, a gap with
  // the lines that run through it.
  const locals = new Map<string, Route[]>(columns.map((n) => [n, []]));
  for (const r of routes) if (r.local) locals.get(r.a.node)!.push(r);
  const laneW = (n: string) => Math.max(MIN_LANE, (locals.get(n)!.length + 1) * LANE_GAP);
  const nodeW = (n: string) => PAD + CARD_W + laneW(n);

  const gaps: Route[][] = Array.from({ length: columns.length + 1 }, () => []);
  const remote = routes.filter((r) => !r.local);
  for (const r of remote) {
    gaps[colOf(r.a) + 1].push(r);
    if (!r.direct) gaps[colOf(r.b)].push(r);
  }
  const gapW = gaps.map((list, k) => {
    const need = (list.length + 1) * LANE_GAP;
    const outer = k === 0 || k === columns.length;
    return list.length ? Math.max(outer ? MIN_GAP / 2 : MIN_GAP, need) : outer ? EDGE_GAP : MIN_GAP;
  });
  const colX: number[] = [];
  let x = gapW[0];
  columns.forEach((n, k) => {
    colX.push(x);
    x += nodeW(n) + gapW[k + 1];
  });
  const width = x;

  // The band over the nodes: one lane per line, the widest span at the top so
  // the narrower ones nest under it.
  const over = remote.filter((r) => !r.direct);
  const span = (r: Route) => Math.abs(colOf(r.b) - colOf(r.a));
  over.sort((p, q) => span(q) - span(p) || p.e.key.localeCompare(q.e.key));
  over.forEach((r, i) => (r.band = (i + 1) * LANE_GAP));
  const top = over.length ? (over.length + 1) * LANE_GAP + BAND_MARGIN : 0;

  columns.forEach((n, k) => {
    rows.get(n)!.forEach((c, i) => {
      c.x = colX[k] + PAD;
      c.y = top + HEAD_H + i * ROW_H;
    });
  });
  const mid = (c: Card) => c.y + c.h / 2;

  // Ports: every line its own point on the card edge, ordered by where the
  // other end is so the lines leave without crossing. Lines leave on the
  // right; they enter on the left from another node and on the right from
  // their own, where the lane runs.
  const right = new Map<string, { r: Route; end: 'a' | 'b' }[]>();
  const left = new Map<string, Route[]>();
  for (const r of routes) {
    right.set(r.a.key, [...(right.get(r.a.key) ?? []), { r, end: 'a' }]);
    if (r.local) right.set(r.b.key, [...(right.get(r.b.key) ?? []), { r, end: 'b' }]);
    else left.set(r.b.key, [...(left.get(r.b.key) ?? []), r]);
  }
  const spread = (c: Card, n: number, i: number) => {
    const step = n > 1 ? Math.min(PORT_GAP, (c.h - 10) / (n - 1)) : 0;
    return mid(c) + (i - (n - 1) / 2) * step;
  };
  for (const [key, list] of right) {
    const c = cards.get(key)!;
    // A line leaving over the top heads up, so it takes an upper port, as it
    // does where it arrives.
    const other = (p: { r: Route; end: 'a' | 'b' }) =>
      p.end === 'a' && !p.r.local && !p.r.direct
        ? -1e6 + p.r.band
        : mid(p.end === 'a' ? p.r.b : p.r.a);
    list.sort((p, q) => other(p) - other(q) || p.r.e.key.localeCompare(q.r.e.key));
    list.forEach((p, i) => {
      if (p.end === 'a') p.r.y1 = spread(c, list.length, i);
      else p.r.y2 = spread(c, list.length, i);
    });
  }
  for (const [key, list] of left) {
    const c = cards.get(key)!;
    // Over the top arrives from above, so those take the upper ports.
    const from = (r: Route) => (r.direct ? mid(r.a) : -1e6 + r.band);
    list.sort((p, q) => from(p) - from(q) || p.e.key.localeCompare(q.e.key));
    list.forEach((r, i) => (r.y2 = spread(c, list.length, i)));
  }

  // Local lanes: the shortest run nearest the cards, so the longer ones go
  // round it rather than across.
  columns.forEach((n, k) => {
    const list = locals.get(n)!;
    list.sort(
      (p, q) => Math.abs(p.y2 - p.y1) - Math.abs(q.y2 - q.y1) || p.e.key.localeCompare(q.e.key),
    );
    const step = laneW(n) / (list.length + 1);
    const base = colX[k] + PAD + CARD_W;
    list.forEach((r, i) => (r.lane = base + (i + 1) * step));
  });

  // Gap lanes: lines climbing out of the left node first, top port leftmost,
  // so none climbs across another's way out; then the ones crossing straight
  // over; then the ones dropping into the right node, lowest port leftmost,
  // so none drops across another's way in. A line over the top climbs and
  // drops in two different gaps: the next node over is reached straight.
  gaps.forEach((list, k) => {
    const start = k === 0 ? 0 : colX[k - 1] + nodeW(columns[k - 1]);
    const climbs = list.filter((r) => !r.direct && colOf(r.a) + 1 === k);
    const drops = list.filter((r) => !r.direct && colOf(r.b) === k);
    const straight = list.filter((r) => r.direct);
    climbs.sort((p, q) => p.y1 - q.y1);
    straight.sort((p, q) => p.y1 - q.y1);
    drops.sort((p, q) => q.y2 - p.y2);
    const step = gapW[k] / (list.length + 1);
    const lane = (i: number) => start + (i + 1) * step;
    climbs.forEach((r, i) => (r.rise = lane(i)));
    straight.forEach((r, i) => (r.lane = lane(climbs.length + i)));
    drops.forEach((r, i) => (r.drop = lane(climbs.length + straight.length + i)));
  });

  const wires = routes.map((r): Wire => {
    const x1 = r.a.x + r.a.w;
    let points: Point[];
    let tip: Point;
    let dir: 1 | -1;
    if (r.local) {
      // Down the node's own lane and back into the reader. Routing it outside
      // the box would draw a read that never leaves the node as though it had.
      const x2 = r.b.x + r.b.w;
      points = [
        { x: x1, y: r.y1 },
        { x: r.lane, y: r.y1 },
        { x: r.lane, y: r.y2 },
        { x: x2 + ARROW, y: r.y2 },
      ];
      tip = { x: x2, y: r.y2 };
      dir = -1;
    } else if (r.direct) {
      points = [
        { x: x1, y: r.y1 },
        { x: r.lane, y: r.y1 },
        { x: r.lane, y: r.y2 },
        { x: r.b.x - ARROW, y: r.y2 },
      ];
      tip = { x: r.b.x, y: r.y2 };
      dir = 1;
    } else {
      points = [
        { x: x1, y: r.y1 },
        { x: r.rise, y: r.y1 },
        { x: r.rise, y: r.band },
        { x: r.drop, y: r.band },
        { x: r.drop, y: r.y2 },
        { x: r.b.x - ARROW, y: r.y2 },
      ];
      tip = { x: r.b.x, y: r.y2 };
      dir = 1;
    }
    points = points.map(round);
    tip = round(tip);
    const base = points[points.length - 1];
    return {
      key: r.e.key,
      from: r.e.from,
      to: r.e.to,
      kind: r.e.kind,
      local: r.local,
      state: r.e.state,
      title: r.e.title,
      rate: r.e.rate,
      channels: r.e.channels,
      points,
      d: rounded(points),
      tip,
      dir,
      head: [tip, { x: base.x, y: base.y - ARROW_HALF }, { x: base.x, y: base.y + ARROW_HALF }]
        .map((p) => `${p.x},${p.y}`)
        .join(' '),
    };
  });

  const nodes = columns.map((name, k): NodeBox => {
    const n = rows.get(name)!.length;
    return {
      name,
      x: colX[k],
      y: top,
      w: nodeW(name),
      h: HEAD_H + Math.max(n, 1) * ROW_H,
    };
  });
  const height = nodes.length ? Math.max(...nodes.map((b) => b.y + b.h)) : 0;

  return {
    nodes,
    cards: [...cards.values()],
    wires,
    w: Math.ceil(width),
    h: Math.ceil(height + 4),
  };
}

/** A function card's key: its production, its name and its node. A redundant
 *  booking runs an engine on each of two nodes, and each writes and reads
 *  where it runs. */
export function fnKey(end: GraphEnd): string {
  return `fn:${end.production ?? ''}/${end.function}@${end.node ?? ''}`;
}

/** Node names carry the cluster's name on every one of them. What runs on no
 *  node has no name to shorten and says so instead. */
export function shortNode(node: string): string {
  if (!node) return 'NO NODE';
  return node.replace(/^.*-demo-/, '');
}

function round(p: Point): Point {
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 };
}

/** An orthogonal polyline with its corners rounded off. Zero-length runs and
 *  points along a straight run are dropped first, so no corner is rounded
 *  that is not one. */
function rounded(input: readonly Point[]): string {
  const p: Point[] = [];
  for (const q of input) {
    const last = p[p.length - 1];
    if (last && last.x === q.x && last.y === q.y) continue;
    const prev = p[p.length - 2];
    if (
      prev &&
      last &&
      ((prev.x === last.x && last.x === q.x) || (prev.y === last.y && last.y === q.y))
    ) {
      p[p.length - 1] = q;
      continue;
    }
    p.push(q);
  }
  let d = `M ${p[0].x} ${p[0].y}`;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1];
    const c = p[i];
    const b = p[i + 1];
    const r = Math.min(CORNER, dist(a, c) / 2, dist(c, b) / 2);
    const from = toward(c, a, r);
    const to = toward(c, b, r);
    d += ` L ${from.x} ${from.y} Q ${c.x} ${c.y} ${to.x} ${to.y}`;
  }
  const end = p[p.length - 1];
  return d + ` L ${end.x} ${end.y}`;
}

function dist(a: Point, b: Point): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function toward(from: Point, to: Point, r: number): Point {
  const l = dist(from, to) || 1;
  return round({ x: from.x + ((to.x - from.x) * r) / l, y: from.y + ((to.y - from.y) * r) / l });
}
