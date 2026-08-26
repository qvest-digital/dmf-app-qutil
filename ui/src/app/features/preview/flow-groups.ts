import { OperatorFlow } from '../../core/api/models';

/**
 * Flows that came from one source, as its NMOS group hint names them.
 *
 * A producer tags each flow it writes with `urn:x-nmos:tag:grouphint/v1.0`,
 * carrying `<source>:<role>`. An SRT ingest writing picture, sound and
 * ancillary data tags all three with the same source, which is the only thing
 * in the system that says those flows belong together.
 *
 * The tag is a list, and the aggregator forwards its first entry only. A flow
 * tagged into several sources therefore groups under whichever the producer
 * wrote first and is invisible to the rest. Nothing here can recover the
 * others: pairing has to be deterministic, because the pair decides the media
 * server path name and two viewers computing different names would run two
 * encoders for one picture. Widening this means carrying the whole list from
 * the aggregator and choosing between sources on something better than order.
 */
export interface FlowGroup {
  source: string;
  video?: OperatorFlow;
  audio?: OperatorFlow;
  data?: OperatorFlow;
}

export interface GroupHint {
  source: string;
  role: string;
}

/**
 * Split a group hint into its source and its role.
 *
 * On the LAST colon: a role is a single word, while a source is free text that
 * nothing forbids a colon in.
 */
export function parseGroupHint(hint: string | null | undefined): GroupHint | null {
  if (!hint) return null;
  const cut = hint.lastIndexOf(':');
  if (cut <= 0 || cut === hint.length - 1) return null;
  return { source: hint.slice(0, cut), role: hint.slice(cut + 1) };
}

/**
 * Which track a role names, or null for one this app has no use for.
 *
 * Case-folded because producers disagree: an SRT ingest writes `Video` and
 * `Audio`, a vendor source writes `video` and `audio`. Ancillary data is two
 * words with a space.
 */
export function roleTrack(role: string): keyof Omit<FlowGroup, 'source'> | null {
  switch (role.trim().toLowerCase()) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'ancillary data':
    case 'data':
      return 'data';
    default:
      return null;
  }
}

/**
 * Group flows by the source their hint names.
 *
 * A flow with no hint, an unparseable one, or a role nothing plays is left out
 * entirely: a group exists to say two flows belong together, and one that
 * cannot say so is not worth offering. Where a source names the same track
 * twice the first wins, which keeps the result stable against a reordered poll.
 */
export function groupFlows(flows: readonly OperatorFlow[]): FlowGroup[] {
  const groups = new Map<string, FlowGroup>();
  for (const flow of flows) {
    const hint = parseGroupHint(flow.grouphint);
    if (!hint) continue;
    const track = roleTrack(hint.role);
    if (!track) continue;
    let group = groups.get(hint.source);
    if (!group) {
      group = { source: hint.source };
      groups.set(hint.source, group);
    }
    if (!group[track]) group[track] = flow;
  }
  return [...groups.values()];
}

/**
 * The audio flow that belongs with a video flow, if the two were tagged
 * together. Null when the video flow carries no hint, its source published no
 * audio, or the flow is not video.
 */
export function audioSiblingOf(
  video: OperatorFlow,
  flows: readonly OperatorFlow[],
): OperatorFlow | null {
  const hint = parseGroupHint(video.grouphint);
  if (!hint || roleTrack(hint.role) !== 'video') return null;
  const group = groupFlows(flows).find((g) => g.source === hint.source);
  return group?.audio ?? null;
}
