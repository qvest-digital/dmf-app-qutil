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
 * name, and their flows merge into a single group here.
 *
 * `members` is every flow the group names, by kind and then by role. The three
 * tracks are what a combined preview plays: one flow each, picked from the
 * members as `groupFlows` describes.
 */
export interface FlowGroup {
  name: string;
  members: OperatorFlow[];
  video?: OperatorFlow;
  audio?: OperatorFlow;
  data?: OperatorFlow;
}

const TRACKS = ['video', 'audio', 'data'] as const;

/** The tracks a combined preview plays, in the order a group lists them. */
export type Track = (typeof TRACKS)[number];

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
export function flowTrack(flow: OperatorFlow): Track | null {
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
 * Every other flow is a member of its group, whatever else the group holds:
 * an output written by several replicas names one group and one role for all
 * of them, and they are one source however many there are.
 *
 * A group may hold several flows of one track -- the register's own example is
 * a camera with two audio senders -- and the track a preview plays has room
 * for one. The lowest role wins it, because that is what the register gives a
 * role for: an index into the group that sorts. Picking on the role rather
 * than on the order the flows arrived in also survives a reordered poll, and
 * it is the difference between `Audio 1` reaching a preview and whichever of
 * `Audio 1` and `Audio 2` happens to hold the lower uuid.
 */
export function groupFlows(flows: readonly OperatorFlow[]): FlowGroup[] {
  const groups = new Map<string, FlowGroup>();
  const roles = new Map<string, string>();
  const rank = new Map<OperatorFlow, [number, string, number]>();
  flows.forEach((flow, i) => {
    const hint = parseGroupHint(flow.grouphint);
    if (!hint) return;
    const track = flowTrack(flow);
    if (!track) return;
    let group = groups.get(hint.group);
    if (!group) {
      group = { name: hint.group, members: [] };
      groups.set(hint.group, group);
    }
    group.members.push(flow);
    rank.set(flow, [TRACKS.indexOf(track), hint.role, i]);
    const held = group[track];
    const key = `${hint.group}:${track}`;
    if (held && byRole(roles.get(key)!, hint.role) <= 0) return;
    group[track] = flow;
    roles.set(key, hint.role);
  });
  for (const group of groups.values()) {
    group.members.sort((a, b) => {
      const [ta, ra, ia] = rank.get(a)!;
      const [tb, rb, ib] = rank.get(b)!;
      return ta - tb || byRole(ra, rb) || ia - ib;
    });
  }
  return [...groups.values()];
}

/**
 * One box in the flow list: the flows to render in it, and the group they were
 * tagged into where there is one.
 *
 * The group travels with the flows rather than being looked up again per box,
 * because it is what the box's header is drawn from: its name, and the picture
 * and sound a combined preview needs.
 */
export interface FlowRow {
  /** Null for a flow no hint put in a group, which is a box of one. */
  group: FlowGroup | null;
  flows: OperatorFlow[];
}

/**
 * The inventory as a list renders it: every flow exactly once, with the flows
 * one producer tagged into a single group adjacent, picture, then sound, then
 * data.
 *
 * A group takes the position of its first member, so a poll that returns the
 * inventory in another order does not move a group somebody is reading.
 * Everything `groupFlows` leaves out -- no hint, a format nothing plays --
 * comes back as a row of its own, because the list still has to show it.
 */
export function groupedFlowRows(flows: readonly OperatorFlow[]): FlowRow[] {
  const byName = new Map(groupFlows(flows).map((g) => [g.name, g]));
  const groupOf = new Map<string, string>();
  for (const [name, group] of byName) {
    for (const member of group.members) groupOf.set(member.id, name);
  }

  const rows: FlowRow[] = [];
  const taken = new Set<string>();
  for (const flow of flows) {
    const name = groupOf.get(flow.id);
    if (name === undefined) {
      rows.push({ group: null, flows: [flow] });
      continue;
    }
    if (taken.has(name)) continue;
    taken.add(name);
    const group = byName.get(name)!;
    rows.push({ group, flows: group.members });
  }
  return rows;
}
