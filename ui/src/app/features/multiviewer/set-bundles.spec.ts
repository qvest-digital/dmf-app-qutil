import { OperatorFlow, RedundancySet } from '../../core/api/models';
import { inventoryRows, ListRow, SetBundle } from './set-bundles';

function flow(id: string, grouphint: string | null, format = 'video'): OperatorFlow {
  return { id, label: id, format, grouphint } as OperatorFlow;
}

function set(name: string, members: string[], output: OperatorFlow): RedundancySet {
  return { name, members, output };
}

// Two engines of one switcher, each writing picture and sound under its own
// group hint, and one set per track picking between them.
const A1 = flow('a1', 'prog:Video');
const A2 = flow('a2', 'prog:Audio', 'audio');
const B1 = flow('b1', 'prog-b:Video');
const B2 = flow('b2', 'prog-b:Audio', 'audio');
const C1 = flow('c1', null);
const C2 = flow('c2', null, 'audio');
const VIDEO_SET = set('p.prog-video', ['a1', 'b1'], C1);
const AUDIO_SET = set('p.prog-audio', ['a2', 'b2'], C2);

const SRT_VIDEO = flow('s1', 'srt-ingest-1:Video');
const SRT_AUDIO = flow('s2', 'srt-ingest-1:Audio', 'audio');
const LONE = flow('l1', null);

function bundles(rows: ListRow[]): SetBundle[] {
  return rows.flatMap((r) => (r.kind === 'sets' ? [r.bundle] : []));
}

function flowIds(rows: ListRow[]): string[][] {
  return rows.flatMap((r) => (r.kind === 'flows' ? [r.row.flows.map((f) => f.id)] : []));
}

describe('inventoryRows', () => {
  it('leaves the group-hint rows alone where there is no set', () => {
    const rows = inventoryRows([SRT_AUDIO, LONE, SRT_VIDEO], []);

    expect(bundles(rows)).toEqual([]);
    expect(flowIds(rows)).toEqual([['s1', 's2'], ['l1']]);
  });

  /**
   * The picture set's members share their groups with the sound set's, so the
   * two are one programme and one box, and each engine's group is offered there.
   */
  it('bundles the sets whose members share a group', () => {
    const rows = inventoryRows([A1, A2, B1, B2, SRT_VIDEO, SRT_AUDIO], [VIDEO_SET, AUDIO_SET]);

    const [bundle, ...more] = bundles(rows);
    expect(more).toEqual([]);
    expect(bundle.sets.map((v) => v.set.name)).toEqual(['p.prog-video', 'p.prog-audio']);
    expect(bundle.sets[0].members.map((m) => m.flow?.id)).toEqual(['a1', 'b1']);
    expect(bundle.groups.map((g) => [g.name, g.video?.id, g.audio?.id])).toEqual([
      ['prog', 'a1', 'a2'],
      ['prog-b', 'b1', 'b2'],
    ]);
    expect(bundle.outputs).toEqual({
      name: 'p.prog-video + p.prog-audio',
      video: C1,
      audio: C2,
    });
    expect(bundle.others).toEqual([]);
  });

  it('shows a member inside its set and nowhere else', () => {
    const rows = inventoryRows([A1, A2, B1, B2, SRT_VIDEO, SRT_AUDIO], [VIDEO_SET, AUDIO_SET]);

    expect(flowIds(rows)).toEqual([['s1', 's2']]);
  });

  /** An MxlFlow on an output's id is the flow the set's merge replaces. */
  it('does not list an MxlFlow on an output id as a flow of its own', () => {
    const rows = inventoryRows([A1, B1, flow('c1', null)], [VIDEO_SET]);

    expect(flowIds(rows)).toEqual([]);
  });

  it('keeps a grouped flow no set takes in beside the set', () => {
    const anc = flow('d1', 'prog:Data', 'data');
    const rows = inventoryRows([A1, B1, anc], [VIDEO_SET]);

    expect(bundles(rows)[0].others).toEqual([anc]);
    expect(flowIds(rows)).toEqual([]);
  });

  it('keeps a member nothing produces, so the set still shows what it waits for', () => {
    const rows = inventoryRows([B1], [VIDEO_SET]);

    expect(bundles(rows)[0].sets[0].members).toEqual([
      { id: 'a1', flow: null },
      { id: 'b1', flow: B1 },
    ]);
  });

  it('gives sets with no shared group a box each', () => {
    const other = set('p.other', ['x1', 'x2'], flow('x3', null));
    const rows = inventoryRows([A1, B1, flow('x1', null), flow('x2', null)], [VIDEO_SET, other]);

    expect(bundles(rows).map((b) => b.sets.map((v) => v.set.name))).toEqual([
      ['p.prog-video'],
      ['p.other'],
    ]);
  });

  /** Joined through a chain of groups, not only directly. */
  it('bundles transitively', () => {
    const third = set('p.third', ['b2', 't1'], flow('t3', null, 'audio'));
    const rows = inventoryRows(
      [A1, A2, B1, B2, flow('t1', 'other:Audio', 'audio')],
      [VIDEO_SET, set('p.mix', ['a2', 'x9'], flow('m3', null, 'audio')), third],
    );

    expect(bundles(rows).map((b) => b.sets.length)).toEqual([3]);
  });
});
