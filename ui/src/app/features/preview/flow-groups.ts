import { OperatorFlow } from '../../core/api/models';

/**
 * The flows one producer put in a single group, as its NMOS group hint names
 * them.
 *
 * A producer tags each flow it writes with `urn:x-nmos:tag:grouphint/v1.0`,
 * whose value is `<group-name>:<role-in-group>[:<group-scope>]`. An SRT ingest
 * writing picture, sound and ancillary data gives all three one group name,
 * which is the only thing in the system that says those flows belong together.
 * The name is the whole of the relationship: what each member carries comes
 * from its own format, and its role only tells the members of one track apart.
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
 * Which track a flow occupies, from the flow's own NMOS format, or null for a
 * format this app cannot play.
 *
 * The role is deliberately not read for this. The register defines no standard
 * roles and its own examples are `Primary` beside `Audio 1`, so a role tells a
 * consumer which member of a group it is looking at and nothing about what the
 * member carries. The format does say, the aggregator already keys its preview
 * endpoints on it, and it is the same string a flow's badge shows.
 */
export function flowTrack(flow: OperatorFlow): keyof Omit<FlowGroup, 'name'> | null {
  switch ((flow.format ?? '').trim().toLowerCase()) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'data':
      return 'data';
    default:
      return null;
  }
}

/**
 * Order two roles the way the register asks them to be read: as an index into a
 * group, sorted alphanumerically, so `Audio 2` comes before `Audio 10`.
 */
function byRole(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Group flows by the group name their hint carries.
 *
 * A flow with no hint, an unparseable one, or a format this app cannot play is
 * left out entirely: a group exists to say two flows belong together, and one
 * that cannot say so is not worth offering.
 *
 * A group may hold several flows of one track -- the register's own example is
 * a camera with two audio senders -- and a track has room for one. The lowest
 * role wins it, because that is what the register gives a role for: an index
 * into the group that sorts. Picking on the role rather than on the order the
 * flows arrived in also survives a reordered poll, and it is the difference
 * between `Audio 1` reaching a preview and whichever of `Audio 1` and `Audio 2`
 * happens to hold the lower uuid.
 */
export function groupFlows(flows: readonly OperatorFlow[]): FlowGroup[] {
  const groups = new Map<string, FlowGroup>();
  const roles = new Map<string, string>();
  for (const flow of flows) {
    const hint = parseGroupHint(flow.grouphint);
    if (!hint) continue;
    const track = flowTrack(flow);
    if (!track) continue;
    let group = groups.get(hint.group);
    if (!group) {
      group = { name: hint.group };
      groups.set(hint.group, group);
    }
    const held = group[track];
    const key = `${hint.group}:${track}`;
    if (held && byRole(roles.get(key)!, hint.role) <= 0) continue;
    group[track] = flow;
    roles.set(key, hint.role);
  }
  return [...groups.values()];
}

/**
 * The audio flow that belongs with a video flow, if the two were tagged into
 * one group. Null when the video flow carries no hint, its group published no
 * audio, or this is not the flow that took the group's video track.
 */
export function audioSiblingOf(
  video: OperatorFlow,
  flows: readonly OperatorFlow[],
): OperatorFlow | null {
  const hint = parseGroupHint(video.grouphint);
  if (!hint) return null;
  const group = groupFlows(flows).find((g) => g.name === hint.group);
  if (group?.video?.id !== video.id) return null;
  return group.audio ?? null;
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
