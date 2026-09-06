import { OperatorFlow } from '../../core/api/models';
import { flowTrack, groupedFlowRows, groupFlows, parseGroupHint } from './flow-groups';

function flow(id: string, grouphint: string | null, format = 'video'): OperatorFlow {
  return { id, label: id, format, grouphint } as OperatorFlow;
}

describe('parseGroupHint', () => {
  it('splits a hint into group and role, scoped to a device by default', () => {
    expect(parseGroupHint('srt-ingest-1:Video')).toEqual({
      group: 'srt-ingest-1',
      role: 'Video',
      scope: 'device',
    });
  });

  /**
   * The scope is optional and the register's examples mostly leave it out, so a
   * producer that does write it must not lose its role to the extra field.
   */
  it('reads the scope a hint states', () => {
    expect(parseGroupHint('tally:left:node')).toEqual({
      group: 'tally',
      role: 'left',
      scope: 'node',
    });
  });

  /**
   * The colon is reserved in every parameter, so a value with a fourth field is
   * malformed. Reading it as a group name with a colon in it would take the
   * scope for a role and group flows that state no relationship.
   */
  it.each(['rack:2:cam:audio', 'srt-ingest-1:Video:device:extra'])(
    'returns null for the malformed %p',
    (hint) => {
      expect(parseGroupHint(hint)).toBeNull();
    },
  );

  /** A scope is `device` or `node` and nothing else. */
  it.each(['srt-ingest-1:Video:system', 'srt-ingest-1:Video:'])('returns null for %p', (hint) => {
    expect(parseGroupHint(hint)).toBeNull();
  });

  it.each([null, undefined, '', 'no-colon', ':leading', 'trailing:'])(
    'returns null for %p',
    (hint) => {
      expect(parseGroupHint(hint as string | null)).toBeNull();
    },
  );
});

describe('flowTrack', () => {
  /** The aggregator sends the format URN's last segment; producers disagree on casing. */
  it.each([
    ['video', 'video'],
    ['Video', 'video'],
    ['audio', 'audio'],
    ['data', 'data'],
    [' Data ', 'data'],
  ])('reads the format %p as %p', (format, track) => {
    expect(flowTrack(flow('f1', null, format))).toBe(track);
  });

  it.each(['mux', 'subtitle', '', undefined, null])('has no track for the format %p', (format) => {
    expect(flowTrack({ id: 'f1', label: 'f1', format } as OperatorFlow)).toBeNull();
  });
});

describe('groupFlows', () => {
  it('puts the tracks of one group together', () => {
    const groups = groupFlows([
      flow('v1', 'srt-ingest-1:Video'),
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('d1', 'srt-ingest-1:Ancillary Data', 'data'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('srt-ingest-1');
    expect(groups[0].video?.id).toBe('v1');
    expect(groups[0].audio?.id).toBe('a1');
    expect(groups[0].data?.id).toBe('d1');
  });

  it('keeps two groups apart', () => {
    const groups = groupFlows([
      flow('v1', 'srt-ingest-1:Video'),
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('v2', 'mcm-55555-1:video'),
      flow('a2', 'mcm-55555-1:audio', 'audio'),
    ]);

    expect(groups.map((g) => g.name).sort()).toEqual(['mcm-55555-1', 'srt-ingest-1']);
    expect(groups.find((g) => g.name === 'mcm-55555-1')?.audio?.id).toBe('a2');
  });

  it('leaves out a flow with no hint', () => {
    expect(groupFlows([flow('v1', null)])).toEqual([]);
  });

  it('leaves out a format nothing plays', () => {
    expect(groupFlows([flow('m1', 'srt-ingest-1:Mux', 'mux')])).toEqual([]);
  });

  /**
   * The register defines no standard roles, and its own example of a camera is
   * `Primary` beside `Audio 1`. Read as tracks those name nothing, so the role
   * is not what says which track a flow fills.
   */
  it('takes the track from the format, whatever the role says', () => {
    const groups = groupFlows([
      flow('v1', 'Camera:Primary'),
      flow('a1', 'Camera:Audio 1', 'audio'),
      flow('d1', 'Camera:Ancillary Data', 'data'),
    ]);

    expect(groups[0].video?.id).toBe('v1');
    expect(groups[0].audio?.id).toBe('a1');
    expect(groups[0].data?.id).toBe('d1');
  });

  /**
   * A camera publishing two audio senders fills the one audio track from the
   * lower role, not from whichever flow the poll returned first.
   */
  it('gives a track to the lowest role', () => {
    const groups = groupFlows([
      flow('a2', 'Camera:Audio 2', 'audio'),
      flow('a1', 'Camera:Audio 1', 'audio'),
    ]);

    expect(groups[0].audio?.id).toBe('a1');
  });

  /** A role indexes a group, so it sorts the way a reader counts. */
  it('sorts a role numerically rather than by digit', () => {
    const groups = groupFlows([
      flow('a10', 'Camera:Audio 10', 'audio'),
      flow('a2', 'Camera:Audio 2', 'audio'),
    ]);

    expect(groups[0].audio?.id).toBe('a2');
  });

  /**
   * Roles are required to be unique inside a group, so two flows in one role is
   * a malformed group. Keeping the first still has to be stable.
   */
  it('keeps the first of two flows in one role', () => {
    const groups = groupFlows([
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('a2', 'srt-ingest-1:Audio', 'audio'),
    ]);

    expect(groups[0].audio?.id).toBe('a1');
  });
});

/**
 * A group only reads as one box while its flows render next to each other, so
 * what this returns is the render order, not just the pairing. Each box also
 * carries the group it renders, which is what its head is drawn from.
 */
describe('groupedFlowRows', () => {
  /** The ids of each box, in the order the list renders them. */
  function ids(flows: OperatorFlow[]): string[][] {
    return groupedFlowRows(flows).map((r) => r.flows.map((f) => f.id));
  }

  it('puts a group in one row, picture first', () => {
    expect(
      ids([
        flow('d1', 'srt-ingest-1:Ancillary Data', 'data'),
        flow('a1', 'srt-ingest-1:Audio', 'audio'),
        flow('v1', 'srt-ingest-1:Video'),
      ]),
    ).toEqual([['v1', 'a1', 'd1']]);
  });

  it('keeps a group that published one track alone in its row', () => {
    expect(ids([flow('v1', 'lone:Video')])).toEqual([['v1']]);
  });

  /** A poll that reorders the inventory must not move a group up the list. */
  it('leaves a group where its first member was', () => {
    expect(
      ids([
        flow('x1', null),
        flow('a1', 'srt-ingest-1:Audio', 'audio'),
        flow('x2', null),
        flow('v1', 'srt-ingest-1:Video'),
      ]),
    ).toEqual([['x1'], ['v1', 'a1'], ['x2']]);
  });

  it('keeps two groups in separate rows', () => {
    expect(
      ids([
        flow('v1', 'srt-ingest-1:Video'),
        flow('v2', 'mcm-55555-1:video'),
        flow('a1', 'srt-ingest-1:Audio', 'audio'),
        flow('a2', 'mcm-55555-1:audio', 'audio'),
      ]),
    ).toEqual([
      ['v1', 'a1'],
      ['v2', 'a2'],
    ]);
  });

  /** The list shows the whole inventory, grouped or not. */
  it.each([
    ['a flow with no hint', flow('x1', null)],
    ['a format nothing plays', flow('m1', 'srt-ingest-1:Mux', 'mux')],
    ['the second flow of a track a group named twice', flow('a2', 'srt-ingest-1:Audio', 'audio')],
  ])('gives %s a row of its own', (_name, extra) => {
    expect(
      ids([flow('v1', 'srt-ingest-1:Video'), flow('a1', 'srt-ingest-1:Audio', 'audio'), extra]),
    ).toEqual([['v1', 'a1'], [extra.id]]);
  });

  it('shows every flow exactly once', () => {
    const flows = [
      flow('v1', 'srt-ingest-1:Video'),
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('x1', null),
      flow('m1', 'srt-ingest-1:Mux', 'mux'),
    ];

    expect(groupedFlowRows(flows).flatMap((r) => r.flows)).toHaveLength(flows.length);
  });

  /**
   * The head names the group and previews its pair, so a box that came from a
   * group has to carry the group rather than only its flows.
   */
  it('carries the group a box came from', () => {
    const rows = groupedFlowRows([
      flow('v1', 'srt-ingest-1:Video'),
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
    ]);

    expect(rows[0].group?.name).toBe('srt-ingest-1');
    expect(rows[0].group?.video?.id).toBe('v1');
    expect(rows[0].group?.audio?.id).toBe('a1');
  });

  /** A box with no group gets no head, so nothing may stand in for one. */
  it('carries no group for a flow no hint grouped', () => {
    expect(groupedFlowRows([flow('x1', null)])[0].group).toBeNull();
  });
});
