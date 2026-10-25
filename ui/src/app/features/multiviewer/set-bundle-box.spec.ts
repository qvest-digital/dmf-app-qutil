import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OperatorFlow, RedundancySet } from '../../core/api/models';
import { PreviewController } from '../preview/preview-controller';
import { SetBundleBox, setState } from './set-bundle-box';
import { inventoryRows, SetBundle } from './set-bundles';

const A1: OperatorFlow = {
  id: '5fd00000-0000-4000-8000-0000000000a1',
  label: 'program video',
  format: 'video',
  grouphint: 'prog:Video',
};
const A2: OperatorFlow = {
  id: '5fd00000-0000-4000-8000-0000000000a2',
  label: 'program audio',
  format: 'audio',
  grouphint: 'prog:Audio',
  detail: { media: { channels: 2 } },
};
const B1: OperatorFlow = {
  id: '5fd00000-0000-4000-8000-0000000000b1',
  label: 'program video (engine b)',
  format: 'video',
  grouphint: 'prog-b:Video',
};
const B2: OperatorFlow = {
  id: '5fd00000-0000-4000-8000-0000000000b2',
  label: 'program audio (engine b)',
  format: 'audio',
  grouphint: 'prog-b:Audio',
};

function output(id: string, format: string, name: string): OperatorFlow {
  return {
    id,
    label: name,
    format,
    grouphint: null,
    locations: [{ node: 'worker-1', phase: 'Merged' }],
    detail: { media: { channels: format === 'audio' ? 2 : null } },
  };
}

const READY = { type: 'Valid', status: 'True', reason: 'MembersAligned' };
const MEMBERS_READY = { type: 'MembersReady', status: 'True', reason: 'MembersReady' };

const VIDEO_SET: RedundancySet = {
  name: 'p-show.prog-video',
  preference: 'Ordered',
  nodes: ['worker-1'],
  members: [A1.id, B1.id],
  valid: READY,
  membersReady: MEMBERS_READY,
  output: output('5fd00000-0000-4000-8000-0000000000c1', 'video', 'p-show.prog-video'),
};
const AUDIO_SET: RedundancySet = {
  name: 'p-show.prog-audio',
  preference: 'Ordered',
  nodes: ['worker-1'],
  members: [A2.id, B2.id],
  valid: READY,
  membersReady: {
    type: 'MembersReady',
    status: 'False',
    reason: 'MemberMissing',
    message: `member ${B2.id} has no producer`,
  },
  output: output('5fd00000-0000-4000-8000-0000000000c2', 'audio', 'p-show.prog-audio'),
};

function bundleOf(flows: OperatorFlow[], sets: RedundancySet[]): SetBundle {
  const row = inventoryRows(flows, sets)[0];
  if (row.kind !== 'sets') throw new Error('no set bundle');
  return row.bundle;
}

describe('SetBundleBox', () => {
  let fixture: ComponentFixture<SetBundleBox>;
  let controller: PreviewController;

  function mount(bundle: SetBundle): void {
    fixture = TestBed.createComponent(SetBundleBox);
    fixture.componentRef.setInput('bundle', bundle);
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement;
  }

  /** Each row's role badge and label, in the order the box shows them. */
  function rows(): string[] {
    return Array.from(el().querySelectorAll('.flow .name, .rs-missing')).map((n) =>
      Array.from(n.childNodes)
        .filter((c) => c.nodeType !== Node.COMMENT_NODE)
        .map((c) => c.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
  }

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [SetBundleBox] });
    controller = TestBed.inject(PreviewController);
  });

  afterEach(() => {
    for (const request of controller.requests()) controller.close(request.id);
  });

  it('shows each set with its output first and its members in order of preference', () => {
    mount(bundleOf([A1, A2, B1, B2], [VIDEO_SET, AUDIO_SET]));

    expect(Array.from(el().querySelectorAll('.rs-name')).map((n) => n.textContent?.trim())).toEqual(
      ['p-show.prog-video', 'p-show.prog-audio'],
    );
    expect(rows()).toEqual([
      'output p-show.prog-video video',
      'member 1 program video video',
      'member 2 program video (engine b) video',
      'output p-show.prog-audio audio',
      'member 1 program audio audio',
      'member 2 program audio (engine b) audio',
    ]);
  });

  /** The operator's own words for a member the output is served without. */
  it('says which state each set is in, and why one is degraded', () => {
    mount(bundleOf([A1, A2, B1, B2], [VIDEO_SET, AUDIO_SET]));

    const heads = Array.from(el().querySelectorAll('.rs-head')) as HTMLElement[];
    expect(heads[0].querySelector('.dot')?.className).toContain('live');
    expect(heads[0].textContent).toContain('valid | members ready');
    expect(heads[0].textContent).toContain('wanted on worker-1');
    expect(heads[1].querySelector('.dot')?.className).toContain('bad');
    expect(heads[1].textContent).toContain('members missing');
    expect(heads[1].querySelector('.rs-warn')?.textContent).toContain(
      `member ${B2.id} has no producer`,
    );
  });

  /** A condition from an older spec says nothing about this one. */
  it('reads a condition written for an older generation as unknown', () => {
    const stale: RedundancySet = {
      ...VIDEO_SET,
      generation: 3,
      observedGeneration: 2,
      valid: { ...READY, observedGeneration: 2 },
      membersReady: {
        type: 'MembersReady',
        status: 'False',
        reason: 'MembersMisaligned',
        message: 'members differ in grain_rate',
        observedGeneration: 2,
      },
    };
    mount(bundleOf([A1, B1], [stale]));

    const head = el().querySelector('.rs-head') as HTMLElement;
    expect(head.querySelector('.dot')?.className).not.toMatch(/live|bad/);
    expect(head.textContent).toContain('valid? | members ready?');
    expect(head.querySelector('.rs-warn')).toBeNull();
  });

  /** A set naming one flow twice still renders each of its places. */
  it('renders a member named twice in both places', () => {
    mount(bundleOf([A1, B1], [{ ...VIDEO_SET, members: [A1.id, B1.id, A1.id] }]));

    expect(rows().filter((r) => r.startsWith('member'))).toEqual([
      'member 1 program video video',
      'member 2 program video (engine b) video',
      'member 3 program video video',
    ]);
  });

  it('keeps a member nothing produces in its place', () => {
    mount(bundleOf([B1], [VIDEO_SET]));

    expect(rows()).toEqual([
      'output p-show.prog-video video',
      `member 1 ${A1.id} | no MxlFlow: nothing produces it`,
      'member 2 program video (engine b) video',
    ]);
  });

  /** Each engine's group keeps the picture-and-sound preview its head offers. */
  it("offers each member group's head", () => {
    mount(bundleOf([A1, A2, B1, B2], [VIDEO_SET, AUDIO_SET]));

    expect(
      Array.from(el().querySelectorAll('mv-flow-group-head .fg-name')).map((n) =>
        n.textContent?.trim(),
      ),
    ).toEqual(['prog', 'prog-b']);
  });

  /**
   * An output carries no group hint, so nothing else pairs the merged picture
   * with the merged sound.
   */
  it('previews the merged picture with the merged sound as one card', () => {
    mount(bundleOf([A1, A2, B1, B2], [VIDEO_SET, AUDIO_SET]));
    (el().querySelector(':scope .rs-bundle > .fg-head .fg-prev') as HTMLButtonElement).click();

    expect(controller.requests()).toEqual([
      {
        id: VIDEO_SET.output.id,
        label: 'p-show.prog-video + p-show.prog-audio',
        format: 'video',
        channels: 2,
        audioId: AUDIO_SET.output.id,
      },
    ]);
  });

  it('previews the output alone from its own row', () => {
    mount(bundleOf([A1, B1], [VIDEO_SET]));
    (el().querySelector('.of-prev') as HTMLButtonElement).click();

    expect(controller.requests().map((r) => r.id)).toEqual([VIDEO_SET.output.id]);
  });

  it('offers no combined preview for a set without a partner track', () => {
    mount(bundleOf([A1, B1], [VIDEO_SET]));

    expect(el().querySelector('.rs-bundle > .fg-head .fg-prev')).toBeNull();
  });
});

describe('setState', () => {
  it.each([
    [READY, MEMBERS_READY, 'live'],
    [READY, { ...MEMBERS_READY, status: 'False' }, 'bad'],
    [{ ...READY, status: 'False' }, MEMBERS_READY, 'bad'],
    [null, null, ''],
  ])('reads %o and %o as %p', (valid, membersReady, state) => {
    expect(
      setState({ name: 'x', members: [], output: { id: 'o', label: 'o' }, valid, membersReady }),
    ).toBe(state);
  });
});
