import { OperatorFlow } from '../../core/api/models';

/**
 * The flows one producer put in a single group, as its NMOS group hint names
 * them.
 *
 * A producer tags each flow it writes with `urn:x-nmos:tag:grouphint/v1.0`,
 * whose value is `<group-name>:<role-in-group>[:<group-scope>]`. An SRT ingest
 * writing picture, sound and ancillary data gives all three one group name,
 * which is the only thing in the system that says those flows belong together.
 *
 * The tag is an array, and the register defines its first entry as the natural
 * group: any further entry is a membership meant for something other than
 * natural grouping. The aggregator forwards the first entry, so what arrives
 * here is the whole of what grouping is defined on.
 *
 * A group resolves only inside its scope, and the default scope is one device.
 * Nothing in the flow inventory names the device a flow came from, so the scope
 * cannot be honoured: two devices of one model are meant to carry one group
 * name, and their flows merge into a single group here. Where that happens the
 * first flow of each track wins, which at least keeps the result stable against
 * a reordered poll.
 */
export interface FlowGroup {
  name: string;
  video?: OperatorFlow;
  audio?: OperatorFlow;
  data?: OperatorFlow;
}

export interface GroupHint {
  group: string;
  role: string;
  /** `device` where the hint leaves it out, which is the register's default. */
  scope: 'device' | 'node';
}

/**
 * Split a group hint into its parts, or null where it carries no relationship.
 *
 * The colon is reserved: the register forbids one inside a group name, a role
 * and a scope alike. So a hint has two fields or three, the split runs from the
 * left, and a fourth field is a malformed hint rather than a name with a colon
 * in it. A third field that is neither `device` nor `node` is malformed the
 * same way.
 */
export function parseGroupHint(hint: string | null | undefined): GroupHint | null {
  if (!hint) return null;
  const [group, role, scope, ...rest] = hint.split(':');
  if (!group || !role || rest.length) return null;
  if (scope !== undefined && scope !== 'device' && scope !== 'node') return null;
  return { group, role, scope: scope ?? 'device' };
}

/**
 * Which track a role names, or null for one this app has no use for.
 *
 * The register defines no standard roles, so this matches what the producers in
 * this system write and nothing else: an SRT ingest writes `Video` and `Audio`,
 * a vendor source writes them lower case, and ancillary data arrives as one
 * word or as two. A device naming its roles the way the register's own examples
 * do, `Primary` beside `Audio 1`, groups under none of them.
 */
export function roleTrack(role: string): keyof Omit<FlowGroup, 'name'> | null {
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
 * Group flows by the group name their hint carries.
 *
 * A flow with no hint, an unparseable one, or a role nothing plays is left out
 * entirely: a group exists to say two flows belong together, and one that
 * cannot say so is not worth offering. Where a group names the same track twice
 * the first wins, which keeps the result stable against a reordered poll.
 */
export function groupFlows(flows: readonly OperatorFlow[]): FlowGroup[] {
  const groups = new Map<string, FlowGroup>();
  for (const flow of flows) {
    const hint = parseGroupHint(flow.grouphint);
    if (!hint) continue;
    const track = roleTrack(hint.role);
    if (!track) continue;
    let group = groups.get(hint.group);
    if (!group) {
      group = { name: hint.group };
      groups.set(hint.group, group);
    }
    if (!group[track]) group[track] = flow;
  }
  return [...groups.values()];
}

/**
 * The audio flow that belongs with a video flow, if the two were tagged into
 * one group. Null when the video flow carries no hint, its group published no
 * audio, or the flow is not the group's video.
 */
export function audioSiblingOf(
  video: OperatorFlow,
  flows: readonly OperatorFlow[],
): OperatorFlow | null {
  const hint = parseGroupHint(video.grouphint);
  if (!hint || roleTrack(hint.role) !== 'video') return null;
  const group = groupFlows(flows).find((g) => g.name === hint.group);
  return group?.audio ?? null;
}

/** The flows a group published, picture first, in the order a row shows them. */
function groupMembers(group: FlowGroup): OperatorFlow[] {
  return [group.video, group.audio, group.data].filter((f): f is OperatorFlow => !!f);
}

/**
 * The inventory as a list renders it: every flow exactly once, with the flows
 * one producer tagged into a single group adjacent and in track order.
 *
 * A group takes the position of its first member, so a poll that returns the
 * inventory in another order does not move a group somebody is reading.
 * Everything `groupFlows` leaves out -- no hint, a role nothing plays, the
 * second flow of a track a group named twice -- comes back as a row of its own,
 * because the list still has to show it.
 */
export function groupedFlowRows(flows: readonly OperatorFlow[]): OperatorFlow[][] {
  const byName = new Map(groupFlows(flows).map((g) => [g.name, groupMembers(g)]));
  const groupOf = new Map<string, string>();
  for (const [name, members] of byName) {
    for (const member of members) groupOf.set(member.id, name);
  }

  const rows: OperatorFlow[][] = [];
  const taken = new Set<string>();
  for (const flow of flows) {
    const name = groupOf.get(flow.id);
    if (name === undefined) {
      rows.push([flow]);
      continue;
    }
    if (taken.has(name)) continue;
    taken.add(name);
    rows.push(byName.get(name)!);
  }
  return rows;
}
