import { OperatorFlow } from '../../core/api/models';
import { audioSiblingOf, groupFlows, parseGroupHint, roleTrack } from './flow-groups';

function flow(id: string, grouphint: string | null, format = 'video'): OperatorFlow {
  return { id, label: id, format, grouphint } as OperatorFlow;
}

describe('parseGroupHint', () => {
  it('splits a hint into source and role', () => {
    expect(parseGroupHint('srt-ingest-1:Video')).toEqual({ source: 'srt-ingest-1', role: 'Video' });
  });

  /**
   * A source name is free text. One vendor writes a uuid with a serial and an
   * index appended, and nothing forbids a colon inside it, so the split has to
   * come from the right.
   */
  it('splits on the last colon so a source may contain one', () => {
    expect(parseGroupHint('rack:2:cam:audio')).toEqual({ source: 'rack:2:cam', role: 'audio' });
  });

  it.each([null, undefined, '', 'no-colon', ':leading', 'trailing:'])(
    'returns null for %p',
    (hint) => {
      expect(parseGroupHint(hint as string | null)).toBeNull();
    },
  );
});

describe('roleTrack', () => {
  /** Producers disagree on casing, and ancillary data is two words. */
  it.each([
    ['Video', 'video'],
    ['video', 'video'],
    ['Audio', 'audio'],
    ['audio', 'audio'],
    ['Ancillary Data', 'data'],
    ['ancillary data', 'data'],
    [' Video ', 'video'],
  ])('reads %p as %p', (role, track) => {
    expect(roleTrack(role)).toBe(track);
  });

  it.each(['mux', 'subtitle', ''])('has no track for %p', (role) => {
    expect(roleTrack(role)).toBeNull();
  });
});

describe('groupFlows', () => {
  it('puts the tracks of one source together', () => {
    const groups = groupFlows([
      flow('v1', 'srt-ingest-1:Video'),
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('d1', 'srt-ingest-1:Ancillary Data', 'data'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('srt-ingest-1');
    expect(groups[0].video?.id).toBe('v1');
    expect(groups[0].audio?.id).toBe('a1');
    expect(groups[0].data?.id).toBe('d1');
  });

  it('keeps two sources apart', () => {
    const groups = groupFlows([
      flow('v1', 'srt-ingest-1:Video'),
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('v2', 'mcm-55555-1:video'),
      flow('a2', 'mcm-55555-1:audio', 'audio'),
    ]);

    expect(groups.map((g) => g.source).sort()).toEqual(['mcm-55555-1', 'srt-ingest-1']);
    expect(groups.find((g) => g.source === 'mcm-55555-1')?.audio?.id).toBe('a2');
  });

  it('leaves out a flow with no hint', () => {
    expect(groupFlows([flow('v1', null)])).toEqual([]);
  });

  it('leaves out a role with nothing to play it', () => {
    expect(groupFlows([flow('m1', 'srt-ingest-1:mux')])).toEqual([]);
  });

  /** A reordered poll must not change which flow a group names. */
  it('keeps the first of a duplicated track', () => {
    const groups = groupFlows([
      flow('a1', 'srt-ingest-1:Audio', 'audio'),
      flow('a2', 'srt-ingest-1:Audio', 'audio'),
    ]);

    expect(groups[0].audio?.id).toBe('a1');
  });
});

describe('audioSiblingOf', () => {
  const flows = [
    flow('v1', 'srt-ingest-1:Video'),
    flow('a1', 'srt-ingest-1:Audio', 'audio'),
    flow('v2', 'lone:Video'),
  ];

  it('finds the audio tagged with the same source', () => {
    expect(audioSiblingOf(flows[0], flows)?.id).toBe('a1');
  });

  it('has none when the source published no audio', () => {
    expect(audioSiblingOf(flows[2], flows)).toBeNull();
  });

  it('has none for a flow with no hint', () => {
    expect(audioSiblingOf(flow('v3', null), flows)).toBeNull();
  });

  /** Asking an audio flow for its audio sibling is a caller error, not a pair. */
  it('has none when asked about a flow that is not the video track', () => {
    expect(audioSiblingOf(flows[1], flows)).toBeNull();
  });
});
