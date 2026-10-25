import { OperatorFlow, RedundancySet } from '../../core/api/models';
import {
  FlowGroup,
  FlowRow,
  flowTrack,
  groupedFlowRows,
  groupFlows,
  parseGroupHint,
} from '../preview/flow-groups';

/** One member of a set, with its inventory row where the operator has one. */
export interface SetMember {
  id: string;
  /** Null for a member nothing produces yet: the set still names it. */
  flow: OperatorFlow | null;
}

export interface SetView {
  set: RedundancySet;
  /** In spec order, which is the order of preference. */
  members: SetMember[];
}

/**
 * The sets whose members one producer tagged into the same NMOS groups, shown
 * as one box.
 *
 * A producer running two engines writes each engine's picture and sound under
 * its own group hint, and one set per track picks between the engines: the
 * picture set's members are in the same groups as the sound set's. Kept apart,
 * the two sets would hide that their outputs are one programme, and the groups
 * would be split across boxes.
 */
export interface SetBundle {
  sets: SetView[];
  /** The members' own NMOS groups: each engine's picture and sound. */
  groups: FlowGroup[];
  /** The sets' outputs as one group, named after the sets: what a combined
   *  preview needs. */
  outputs: FlowGroup;
  /** Flows of those groups that no set in the bundle takes in. */
  others: OperatorFlow[];
}

export type ListRow = { kind: 'flows'; row: FlowRow } | { kind: 'sets'; bundle: SetBundle };

function groupOf(flow: OperatorFlow | null | undefined): string | null {
  return parseGroupHint(flow?.grouphint)?.group ?? null;
}

/**
 * The inventory as the list renders it: every set once, inside a bundle with
 * the sets its members share a group with, then every flow no set takes in,
 * grouped by hint as before.
 *
 * A member is shown inside its set and nowhere else, and so is an output: it
 * has no MxlFlow, and an MxlFlow that did carry its id would be the flow the
 * set's merge replaces.
 */
export function inventoryRows(
  flows: readonly OperatorFlow[],
  sets: readonly RedundancySet[],
): ListRow[] {
  const byId = new Map(flows.map((f) => [f.id, f]));
  const views: SetView[] = sets.map((set) => ({
    set,
    members: set.members.map((id) => ({ id, flow: byId.get(id) ?? null })),
  }));

  // Sets are bundled where any of their members share a group name: a
  // union-find over the sets, joined through the groups.
  const parent = views.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const ownerOfGroup = new Map<string, number>();
  views.forEach((view, i) => {
    for (const member of view.members) {
      const group = groupOf(member.flow);
      if (group === null) continue;
      const owner = ownerOfGroup.get(group);
      if (owner === undefined) ownerOfGroup.set(group, i);
      else parent[find(i)] = find(owner);
    }
  });

  const bundles = new Map<number, SetView[]>();
  views.forEach((view, i) => {
    const root = find(i);
    bundles.set(root, [...(bundles.get(root) ?? []), view]);
  });

  const taken = new Set<string>();
  for (const view of views) {
    taken.add(view.set.output.id);
    for (const member of view.members) taken.add(member.id);
  }

  const rows: ListRow[] = [];
  for (const bundled of bundles.values()) {
    const names = new Set<string>();
    for (const view of bundled) {
      for (const member of view.members) {
        const group = groupOf(member.flow);
        if (group !== null) names.add(group);
      }
    }
    const grouped = flows.filter((f) => names.has(groupOf(f) ?? ''));
    const others = grouped.filter((f) => !taken.has(f.id));
    for (const flow of others) taken.add(flow.id);

    const outputs: FlowGroup = { name: bundled.map((v) => v.set.name).join(' + ') };
    for (const view of bundled) {
      const track = flowTrack(view.set.output);
      if (track && !outputs[track]) outputs[track] = view.set.output;
    }
    rows.push({
      kind: 'sets',
      bundle: { sets: bundled, groups: groupFlows(grouped), outputs, others },
    });
  }

  for (const row of groupedFlowRows(flows.filter((f) => !taken.has(f.id)))) {
    rows.push({ kind: 'flows', row });
  }
  return rows;
}
