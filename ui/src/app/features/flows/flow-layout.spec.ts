import { MxlGraph } from '../../core/api/models';
import {
  ACROSS,
  DEGRADED,
  ENGINES,
  LEFTWARD,
  LOCAL_LEG,
  PAIR,
  PLAIN,
  READER_OFF_MERGE,
  TWO_PRODUCTIONS,
  TWO_REMOTE_LEGS,
  UNREAD,
} from './flow-fixtures';
import {
  ARROW,
  Card,
  FlowLayout,
  layoutFlows,
  NO_NODE,
  Point,
  setState,
  Wire,
} from './flow-layout';

const card = (l: FlowLayout, key: string): Card => {
  const c = l.cards.find((x) => x.key === key);
  if (!c) throw new Error(`no card ${key} in ${l.cards.map((x) => x.key).join(', ')}`);
  return c;
};

const wire = (l: FlowLayout, from: string, to: string): Wire => {
  const w = l.wires.find((x) => x.from === from && x.to === to);
  if (!w) throw new Error(`no wire ${from} -> ${to}`);
  return w;
};

const node = (l: FlowLayout, name: string) => l.nodes.find((n) => n.name === name)!;

const within = (c: Card, y: number) => y > c.y && y < c.y + c.h;

/**
 * The checks every line has to pass: it leaves its source card on the right
 * edge, its arrowhead touches the target card on the edge it arrives at, and
 * points into that card rather than away from it.
 */
function expectConnects(l: FlowLayout, w: Wire): void {
  const a = card(l, w.from);
  const b = card(l, w.to);
  const start = w.points[0];
  expect(start.x).toBe(a.x + a.w);
  expect(within(a, start.y)).toBe(true);

  expect(within(b, w.tip.y)).toBe(true);
  expect(w.tip.x).toBe(w.dir === 1 ? b.x : b.x + b.w);

  // The arrowhead runs from the end of the line to the tip, in the direction
  // the tip says, one arrowhead long.
  const base = w.points[w.points.length - 1];
  expect(base.y).toBe(w.tip.y);
  expect(w.tip.x - base.x).toBe(w.dir * ARROW);
  expect(w.head.split(' ')[0]).toBe(`${w.tip.x},${w.tip.y}`);
}

type Seg = [Point, Point];
const segments = (w: Wire): Seg[] =>
  w.points
    .slice(1)
    .map((p, i) => [w.points[i], p] as Seg)
    .concat([[w.points.at(-1)!, w.tip]]);

/** Whether an axis-aligned run passes through the inside of a card. */
function crosses([p, q]: Seg, c: Card): boolean {
  const [x1, x2] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
  const [y1, y2] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  return x2 > c.x && x1 < c.x + c.w && y2 > c.y && y1 < c.y + c.h;
}

/** No line runs through a card other than its own two ends. */
function expectClear(l: FlowLayout): void {
  for (const w of l.wires) {
    for (const c of l.cards) {
      if (c.key === w.from || c.key === w.to) continue;
      for (const s of segments(w)) {
        expect(crosses(s, c), `${w.key} runs through ${c.key}`).toBe(false);
      }
    }
  }
}

/** No two lines share a stretch of path, so neither hides the other. */
function expectApart(l: FlowLayout): void {
  const overlap = ([p, q]: Seg, [r, s]: Seg) => {
    if (p.x === q.x && r.x === s.x && p.x === r.x) {
      return (
        Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y)) >
        Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y))
      );
    }
    if (p.y === q.y && r.y === s.y && p.y === r.y) {
      return (
        Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x)) >
        Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x))
      );
    }
    return false;
  };
  l.wires.forEach((w, i) =>
    l.wires.slice(i + 1).forEach((v) => {
      for (const s of segments(w)) {
        for (const t of segments(v)) {
          expect(overlap(s, t), `${w.key} and ${v.key} share a stretch`).toBe(false);
        }
      }
    }),
  );
}

function expectSound(g: MxlGraph): FlowLayout {
  const l = layoutFlows(g);
  for (const w of l.wires) expectConnects(l, w);
  expectClear(l);
  expectApart(l);
  return l;
}

describe('layoutFlows', () => {
  /** Mutation guard: the checks above must be able to fail. */
  it('catches a line that points away from its target', () => {
    const l = layoutFlows(PLAIN);
    const w = wire(l, 'fn:/writer@n01', 'fn:/far-viewer@n02');
    const flipped = { ...w, dir: -1 as const };
    expect(() => expectConnects(l, flipped)).toThrow();
  });

  it('catches a line through a card and two lines on one path', () => {
    const l = layoutFlows(ACROSS);
    const w = wire(l, 'fn:/writer-a@n01', 'fn:/viewer@n03');
    const start = w.points[0];
    const straight = {
      ...w,
      points: [start, { x: w.tip.x - ARROW, y: start.y }],
      tip: { x: w.tip.x, y: start.y },
    };
    expect(() => expectClear({ ...l, wires: [straight] })).toThrow();
    expect(() => expectApart({ ...l, wires: [w, { ...w, key: 'again' }] })).toThrow();
  });

  describe('a plain flow', () => {
    const l = layoutFlows(PLAIN);

    it('connects every line to its own two cards, clear of the rest', () => {
      expectSound(PLAIN);
    });

    it('reads a flow on its own node inside the node box, into the reader from the right', () => {
      const w = wire(l, 'fn:/writer@n01', 'fn:/local-viewer@n01');
      const n01 = node(l, 'n01');
      expect(w.local).toBe(true);
      expect(w.dir).toBe(-1);
      for (const p of w.points) {
        expect(p.x).toBeGreaterThan(n01.x);
        expect(p.x).toBeLessThan(n01.x + n01.w);
      }
    });

    it('carries a mirrored read across the fabric, into the reader from the left', () => {
      const w = wire(l, 'fn:/writer@n01', 'fn:/far-viewer@n02');
      expect(w.local).toBe(false);
      expect(w.dir).toBe(1);
      expect(w.state).toBe('ok');
    });

    it('marks a remote read whose node holds no copy yet as waiting', () => {
      expect(wire(l, 'fn:/writer@n01', 'fn:/waiting-viewer@n03').state).toBe('pending');
    });
  });

  /**
   * Both nodes write, so they are ordered by name and the reader on n01 sits
   * left of the writer on n02. The old curve ran from the writer's right edge
   * to a point left of the reader and arrived travelling left: the arrowhead
   * sat outside the reader, pointing away from it.
   */
  it('points a read that runs right to left into its reader', () => {
    const l = expectSound(LEFTWARD);
    const w = wire(l, 'fn:/writer-b@n02', 'fn:/viewer@n01');
    expect(card(l, 'fn:/viewer@n01').x).toBeLessThan(card(l, 'fn:/writer-b@n02').x);
    expect(w.dir).toBe(1);
    expect(w.tip.x).toBe(card(l, 'fn:/viewer@n01').x);
  });

  /**
   * A curve from n01 to n03 at the same height ran straight through the cards
   * of n02, under them, so it seemed to start at a writer it has nothing to do
   * with. It goes over the top instead.
   */
  it('takes a read past a node over the top rather than through its cards', () => {
    const l = expectSound(ACROSS);
    const w = wire(l, 'fn:/writer-a@n01', 'fn:/viewer@n03');
    const top = Math.min(...l.nodes.map((n) => n.y));
    expect(Math.min(...w.points.map((p) => p.y))).toBeLessThan(top);
  });

  /**
   * The picture and the sound of one writer read by one function drew the same
   * curve twice, under the same tracking key, so one of them was all there was
   * to see.
   */
  it('gives two flows between the same two functions a line each', () => {
    const l = expectSound(PAIR);
    const both = l.wires.filter((w) => w.from === 'fn:/writer@n01' && w.to === 'fn:/viewer@n02');
    expect(both.length).toBe(2);
    expect(new Set(both.map((w) => w.key)).size).toBe(2);
    expect(both[0].d).not.toBe(both[1].d);
    expect(both[0].tip.y).not.toBe(both[1].tip.y);
  });

  /** Lines over the top run in lanes of their own, all of them above every
   *  node box, so none of them crosses a node's heading. */
  it('keeps the band over the top above the nodes, one lane per line', () => {
    for (const g of [ACROSS, LEFTWARD, DEGRADED, TWO_REMOTE_LEGS]) {
      const l = layoutFlows(g);
      const top = Math.min(...l.nodes.map((n) => n.y));
      const lanes = l.wires.filter((w) => w.points.length === 6).map((w) => w.points[2].y);
      expect(lanes.length).toBeGreaterThan(0);
      expect(new Set(lanes).size).toBe(lanes.length);
      for (const y of lanes) {
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(top);
      }
    }
  });

  describe("a redundancy set with a member on the reader's node", () => {
    const l = layoutFlows(LOCAL_LEG);

    it('connects every line to its own two cards, clear of the rest', () => {
      expectSound(LOCAL_LEG);
    });

    it('puts each member at its origin and the output where it is merged', () => {
      expect(card(l, 'member:sf-video:a').node).toBe('n04');
      expect(card(l, 'member:sf-video:b').node).toBe('n06');
      expect(card(l, 'output:sf-video:n04').node).toBe('n04');
      expect(card(l, 'output:sf-video:n04').state).toBe('ok');
    });

    it('draws the local member as a leg inside the node, with no mirror', () => {
      const w = wire(l, 'member:sf-video:a', 'output:sf-video:n04');
      expect(w.kind).toBe('leg');
      expect(w.local).toBe(true);
      expect(w.dir).toBe(-1);
      expect(w.title).toContain('no mirror');
      const n04 = node(l, 'n04');
      for (const p of w.points) expect(p.x).toBeLessThan(n04.x + n04.w);
    });

    it('draws the other member as a mirrored leg into the output', () => {
      const w = wire(l, 'member:sf-video:b', 'output:sf-video:n04');
      expect(w.kind).toBe('leg');
      expect(w.local).toBe(false);
      expect(w.state).toBe('ok');
      expect(w.dir).toBe(1);
      expect(w.title).toContain('mirror Ready');
    });

    it('reads the output on its own node', () => {
      const w = wire(l, 'output:sf-video:n04', 'fn:/monitor@n04');
      expect(w.local).toBe(true);
      expect(w.kind).toBe('read');
      expect(w.state).toBe('ok');
    });

    /** The reader is on the merge node, so it reads the one output card
     *  there rather than one of its own. */
    it('draws one output card for a reader on the merge node', () => {
      expect(l.cards.filter((c) => c.kind === 'output').map((c) => c.key)).toEqual([
        'output:sf-video:n04',
      ]);
    });

    it('stacks member, output and reader down the node in that order', () => {
      const ys = ['member:sf-video:a', 'output:sf-video:n04', 'fn:/monitor@n04'].map(
        (k) => card(l, k).y,
      );
      expect([...ys].sort((p, q) => p - q)).toEqual(ys);
    });
  });

  describe('a redundancy set read from two other nodes', () => {
    const l = layoutFlows(TWO_REMOTE_LEGS);

    it('connects every line to its own two cards, clear of the rest', () => {
      expectSound(TWO_REMOTE_LEGS);
    });

    it('brings both legs across the fabric into the output', () => {
      const a = wire(l, 'member:sf-video:a', 'output:sf-video:n03');
      const b = wire(l, 'member:sf-video:b', 'output:sf-video:n03');
      for (const w of [a, b]) {
        expect(w.local).toBe(false);
        expect(w.dir).toBe(1);
        expect(w.state).toBe('ok');
      }
      // One port each on the output's edge.
      expect(a.tip.y).not.toBe(b.tip.y);
    });
  });

  describe('a degraded redundancy set', () => {
    const l = layoutFlows(DEGRADED);

    it('connects every line to its own two cards, clear of the rest', () => {
      expectSound(DEGRADED);
    });

    it('shows a member nothing produces in the no-node column, broken', () => {
      const m = card(l, 'member:sf-video:a');
      expect(m.node).toBe(NO_NODE);
      expect(m.state).toBe('broken');
      expect(m.sub).toContain('no MxlFlow');
      expect(wire(l, 'member:sf-video:a', 'output:sf-video:n03').state).toBe('broken');
    });

    it('shows a mirror still coming up as waiting', () => {
      const w = wire(l, 'member:sf-video:b', 'output:sf-video:n03');
      expect(w.state).toBe('pending');
      expect(w.title).toContain('Materializing');
    });

    it("carries the operator's verdict on the output", () => {
      const out = card(l, 'output:sf-video:n03');
      // Served from the member that is left, which is what a set is for.
      expect(out.state).toBe('degraded');
      expect(out.sub).toContain('MemberMissing');
      expect(out.tooltip).toContain('member a has no MxlFlow');
    });
  });

  it('says a reader waits where the output is not merged yet, and where it is', () => {
    const l = layoutFlows(READER_OFF_MERGE);
    expectSound(READER_OFF_MERGE);
    const waiting = card(l, 'output:sf-video:n02');
    expect(waiting.sub).toContain('not merged here yet');
    expect(waiting.tooltip).toContain('merged on n03');
    expect(waiting.sub).not.toContain('no node');
    expect(wire(l, 'output:sf-video:n02', 'fn:/late-monitor@n02').state).toBe('pending');
    expect(card(l, 'output:sf-video:n03').sub).toContain('members ready');
  });

  it('tells a set that cannot be merged from one missing a member', () => {
    const base = DEGRADED.sets![0];
    expect(setState(base)).toBe('degraded');
    expect(setState({ ...base, valid: { status: 'False', reason: 'MembersMisaligned' } })).toBe(
      'broken',
    );
    expect(setState({ ...base, valid: undefined, membersReady: undefined })).toBe('pending');
  });

  it('shows a set whose merging gateway is down as degraded, and one that says nothing as it was', () => {
    const base = LOCAL_LEG.sets![0];
    expect(setState(base)).toBe('ok');
    const down = {
      ...base,
      outputReady: {
        status: 'False',
        reason: 'GatewayNotReady',
        message: 'the output is not served on n04: no gateway there has been Ready for 5s',
      },
    };
    expect(setState(down)).toBe('degraded');
    expect(setState({ ...base, outputReady: { status: 'True', reason: 'GatewaysReady' } })).toBe(
      'ok',
    );
    expect(setState({ ...base, outputReady: undefined })).toBe('ok');

    const l = layoutFlows({ ...LOCAL_LEG, sets: [down] });
    const out = card(l, `output:${down.name}:${down.nodes[0]}`);
    expect(out.state).toBe('degraded');
    expect(out.sub).toContain('GatewayNotReady');
    expect(out.tooltip).toContain('OutputReady: False (GatewayNotReady)');
  });

  it('shows a set nobody reads with its output merged nowhere and no legs', () => {
    const l = expectSound(UNREAD);
    expect(card(l, 'output:sf-video:').node).toBe(NO_NODE);
    expect(card(l, 'output:sf-video:').sub).toContain('merged on no node');
    expect(l.wires.length).toBe(0);
    expect(card(l, 'member:sf-video:a').node).toBe('n04');
  });

  /**
   * A redundant booking is one claim with an engine on each of two nodes.
   * Keyed by production and name alone, both engines were one card on engine
   * a's node, so engine b's program seemed to be written there and both reads
   * of the input ended in the one card.
   */
  it('draws each engine of a redundant booking on its own node', () => {
    const l = expectSound(ENGINES);
    const engines = l.cards.filter((c) => c.title === 'switchframe');
    expect(engines.map((c) => [c.node, c.writes])).toEqual([
      ['n01', true],
      ['n06', true],
    ]);
    const input = 'fn:p-demo/srt-ingest-1@n04';
    for (const node of ['n01', 'n06']) {
      const w = wire(l, input, `fn:p-switch/switchframe@${node}`);
      expect(w.local).toBe(false);
      expect(w.state).toBe('ok');
    }
    expect(
      card(l, 'member:p-switch.switchframe-video:0f9e91f2-2955-4ccb-95f1-51186b97c9fc').node,
    ).toBe('n06');
  });

  /**
   * Claim names repeat across productions. Keyed by name alone, two
   * compositors became one card on whichever node came first, and both reads
   * ended in it, so one production's read looked local and the other vanished.
   */
  it('draws same-named functions of two productions as two cards', () => {
    const l = expectSound(TWO_PRODUCTIONS);
    const compositors = l.cards.filter((c) => c.title === 'compositor');
    expect(compositors.map((c) => c.node).sort()).toEqual(['n01', 'n02']);
    const reads = l.wires.filter((w) => w.kind === 'read');
    expect(reads.length).toBe(2);
    expect(new Set(reads.map((w) => w.to)).size).toBe(2);
    expect(reads.map((w) => w.local).sort()).toEqual([false, true]);
    for (const c of compositors) {
      expect(c.tooltip).toContain(c.node === 'n01' ? 'p-demo' : 'p-e2e');
    }
  });

  /** A leg carries its member's frames and an output read its set's, so each
   *  line knows the rate of what moves through it. */
  it('gives every line the rate of the flow it carries', () => {
    const l = layoutFlows({
      ...LOCAL_LEG,
      flows: [
        { ...PLAIN.flows[0], rate: 25 },
        {
          id: 'a',
          label: 'a',
          kind: 'video',
          group: '',
          originNode: 'n04',
          consumers: [],
          mirrors: [],
          rate: 50,
        },
      ],
    });
    expect(l.wires.find((w) => w.from.endsWith('writer@n01'))!.rate).toBe(25);
    expect(wire(l, 'member:sf-video:a', 'output:sf-video:n04').rate).toBe(50);
    // Member b has no MxlFlow in the list, so its leg has no rate to show.
    expect(wire(l, 'member:sf-video:b', 'output:sf-video:n04').rate).toBeUndefined();
    // The output has no MxlFlow of its own and runs at its members' rate.
    expect(l.wires.find((w) => w.from === 'output:sf-video:n04')!.rate).toBe(50);
  });

  /** An audio line draws one bar per channel, so a set's output read needs a
   *  channel count even where the output has no MxlFlow of its own. */
  describe('channel count of a set output', () => {
    const audio = (id: string, channels?: number) => ({
      id,
      label: id,
      kind: 'audio',
      group: '',
      originNode: 'n04',
      consumers: [],
      mirrors: [],
      channels,
    });
    const outputChannels = (flows: MxlGraph['flows']) =>
      layoutFlows({ ...LOCAL_LEG, flows }).wires.find((w) => w.from === 'output:sf-video:n04')!
        .channels;

    it("takes the first member's count", () => {
      expect(outputChannels([audio('a', 2), audio('b', 8)])).toBe(2);
    });

    it('skips a member without a count', () => {
      expect(outputChannels([audio('a'), audio('b', 8)])).toBe(8);
    });

    it("prefers the output's own count", () => {
      expect(outputChannels([audio('out', 16), audio('a', 2)])).toBe(16);
    });

    it('has none where nothing carries one', () => {
      expect(outputChannels([audio('a')])).toBeUndefined();
    });
  });
});
