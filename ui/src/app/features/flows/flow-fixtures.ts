import { GraphEdge, GraphFlow, GraphSet, MxlGraph } from '../../core/api/models';

/** Graphs the diagram's specs draw: one per shape it has drawn wrong, and one
 *  per way a redundancy set reaches its readers. */

function reader(fn: string, node: string, local: boolean, mirrored = !local): GraphEdge {
  return { function: fn, class: 'mxl-reader', node, ready: true, local, mirrored };
}

function flow(
  id: string,
  writer: string,
  node: string,
  consumers: GraphEdge[],
  kind = 'video',
): GraphFlow {
  return {
    id,
    label: id,
    kind,
    group: '',
    originNode: node,
    producer: { function: writer, class: 'mxl-writer', node, ready: true },
    consumers,
    mirrors: consumers.filter((c) => !c.local && c.mirrored).map((c) => c.node ?? ''),
  };
}

/** One writer read on its own node, mirrored to a second and still waiting
 *  for its copy on a third. */
export const PLAIN: MxlGraph = {
  nodes: ['n01', 'n02', 'n03'],
  flows: [
    flow('cam', 'writer', 'n01', [
      reader('local-viewer', 'n01', true),
      reader('far-viewer', 'n02', false, true),
      reader('waiting-viewer', 'n03', false, false),
    ]),
  ],
};

/** A reader on a node drawn left of the writer's: both nodes write, so they
 *  are ordered by name and the read runs right to left. */
export const LEFTWARD: MxlGraph = {
  nodes: ['n01', 'n02'],
  flows: [
    flow('a', 'writer-a', 'n01', []),
    flow('b', 'writer-b', 'n02', [reader('viewer', 'n01', false)]),
  ],
};

/** A read from the first node to the third, past a second node full of cards. */
export const ACROSS: MxlGraph = {
  nodes: ['n01', 'n02', 'n03'],
  flows: [
    flow('a', 'writer-a', 'n01', [reader('viewer', 'n03', false)]),
    flow('b', 'writer-b', 'n02', [reader('local-b', 'n02', true)]),
    flow('c', 'writer-c', 'n02', [reader('local-c', 'n02', true)]),
  ],
};

/** A writer's picture and sound both read by the same function. */
export const PAIR: MxlGraph = {
  nodes: ['n01', 'n02'],
  flows: [
    flow('pic', 'writer', 'n01', [reader('viewer', 'n02', false)]),
    flow('snd', 'writer', 'n01', [reader('viewer', 'n02', false)], 'audio'),
  ],
};

const READY = { status: 'True', reason: 'MembersReady' };
const VALID = { status: 'True', reason: 'MembersAligned' };

function set(extra: Partial<GraphSet>): GraphSet {
  return {
    name: 'sf-video',
    output: 'out',
    kind: 'video',
    valid: VALID,
    membersReady: READY,
    members: [],
    nodes: [],
    legs: [],
    readers: [],
    ...extra,
  };
}

/** Engine a writes on n04, where the output is read; engine b writes on n06.
 *  Member a reaches the output out of n04's own memory, member b by mirror. */
export const LOCAL_LEG: MxlGraph = {
  nodes: ['n04', 'n06'],
  flows: [],
  sets: [
    set({
      members: [
        { id: 'a', label: 'program (engine a)', originNode: 'n04', exists: true },
        { id: 'b', label: 'program (engine b)', originNode: 'n06', exists: true },
      ],
      nodes: ['n04'],
      legs: [
        { member: 'a', node: 'n04', source: 'n04', local: true, phase: 'Local' },
        { member: 'b', node: 'n04', source: 'n06', local: false, phase: 'Ready' },
      ],
      readers: [{ function: 'monitor', class: 'mxl-reader', node: 'n04', ready: true }],
    }),
  ],
};

/** Both members written elsewhere, merged on a third node. */
export const TWO_REMOTE_LEGS: MxlGraph = {
  nodes: ['n01', 'n02', 'n03'],
  flows: [],
  sets: [
    set({
      members: [
        { id: 'a', label: 'program (engine a)', originNode: 'n01', exists: true },
        { id: 'b', label: 'program (engine b)', originNode: 'n02', exists: true },
      ],
      nodes: ['n03'],
      legs: [
        { member: 'a', node: 'n03', source: 'n01', local: false, phase: 'Ready' },
        { member: 'b', node: 'n03', source: 'n02', local: false, phase: 'Ready' },
      ],
      readers: [{ function: 'monitor', class: 'mxl-reader', node: 'n03', ready: true }],
    }),
  ],
};

/** Member a has no MxlFlow, member b's mirror is still coming up, and the
 *  operator says so. */
export const DEGRADED: MxlGraph = {
  nodes: ['n02', 'n03'],
  flows: [],
  sets: [
    set({
      membersReady: {
        status: 'False',
        reason: 'MemberMissing',
        message: 'member a has no MxlFlow',
      },
      members: [
        { id: 'a', label: 'a', originNode: '', exists: false },
        { id: 'b', label: 'program (engine b)', originNode: 'n02', exists: true },
      ],
      nodes: ['n03'],
      legs: [
        { member: 'a', node: 'n03', source: '', local: false, phase: 'NoOrigin' },
        { member: 'b', node: 'n03', source: 'n02', local: false, phase: 'Materializing' },
      ],
      readers: [{ function: 'monitor', class: 'mxl-reader', node: 'n03', ready: true }],
    }),
  ],
};

/** A set nobody reads yet: its members are written, its output merged nowhere. */
export const UNREAD: MxlGraph = {
  nodes: ['n04', 'n06'],
  flows: [],
  sets: [
    set({
      members: [
        { id: 'a', label: 'program (engine a)', originNode: 'n04', exists: true },
        { id: 'b', label: 'program (engine b)', originNode: 'n06', exists: true },
      ],
    }),
  ],
};

/** A reader on n02 the operator has not added to status.nodes yet, while the
 *  output is merged on n03. */
export const READER_OFF_MERGE: MxlGraph = {
  nodes: ['n01', 'n02', 'n03'],
  flows: [],
  sets: [
    set({
      members: [
        { id: 'a', label: 'program (engine a)', originNode: 'n01', exists: true },
        { id: 'b', label: 'program (engine b)', originNode: 'n03', exists: true },
      ],
      nodes: ['n03'],
      legs: [
        { member: 'a', node: 'n03', source: 'n01', local: false, phase: 'Ready' },
        { member: 'b', node: 'n03', source: 'n03', local: true, phase: 'Local' },
      ],
      readers: [{ function: 'late-monitor', class: 'mxl-reader', node: 'n02', ready: true }],
    }),
  ],
};

/** Two productions each run a compositor under the same claim name, both
 *  reading one writer's flow: one beside the writer, one on another node. */
export const TWO_PRODUCTIONS: MxlGraph = {
  nodes: ['n01', 'n02'],
  flows: [
    {
      id: 'cam',
      label: 'cam',
      kind: 'video',
      group: '',
      originNode: 'n01',
      producer: {
        function: 'writer',
        production: 'p-demo',
        class: 'mxl-writer',
        node: 'n01',
        ready: true,
      },
      consumers: [
        { ...reader('compositor', 'n01', true), production: 'p-demo' },
        { ...reader('compositor', 'n02', false), production: 'p-e2e' },
      ],
      mirrors: ['n02'],
    },
  ],
};

/** A redundant switchframe as a live cluster served it: engine a writes its
 *  program on n01, engine b on n06, and each reads the input written on n04. */
export const ENGINES: MxlGraph = {
  nodes: ['n01', 'n04', 'n06'],
  flows: [
    {
      id: 'b2000000-0000-4000-8000-000000000001',
      label: 'srt-ingest-1 p-demo video',
      kind: 'video',
      group: '',
      originNode: 'n04',
      producer: {
        function: 'srt-ingest-1',
        production: 'p-demo',
        class: 'srt-mxl-ingest',
        node: 'n04',
        ready: true,
      },
      consumers: ['n01', 'n06'].map((node) => ({
        function: 'switchframe',
        production: 'p-switch',
        class: 'switchframe',
        node,
        ready: true,
        local: false,
        mirrored: true,
      })),
      mirrors: ['n01', 'n06'],
    },
    ...[
      ['ff89e6cf-ce09-4e08-8f63-4d6df33e45dd', 'switchframe program video', 'n01'],
      ['0f9e91f2-2955-4ccb-95f1-51186b97c9fc', 'switchframe program video (engine b)', 'n06'],
    ].map(([id, label, node]): GraphFlow => ({
      id,
      label,
      kind: 'video',
      group: '',
      originNode: node,
      producer: {
        function: 'switchframe',
        production: 'p-switch',
        class: 'switchframe',
        node,
        ready: true,
      },
      consumers: [],
      mirrors: [],
    })),
  ],
  sets: [
    set({
      name: 'p-switch.switchframe-video',
      output: 'c29e0276-70c4-4034-ba42-bb73dfe4db30',
      members: [
        {
          id: 'ff89e6cf-ce09-4e08-8f63-4d6df33e45dd',
          label: 'switchframe program video',
          originNode: 'n01',
          exists: true,
          producer: 'switchframe',
          production: 'p-switch',
        },
        {
          id: '0f9e91f2-2955-4ccb-95f1-51186b97c9fc',
          label: 'switchframe program video (engine b)',
          originNode: 'n06',
          exists: true,
          producer: 'switchframe',
          production: 'p-switch',
        },
      ],
    }),
  ],
};
