import { ComponentFixture, TestBed } from '@angular/core/testing';
import { OperatorFlow } from '../../core/api/models';
import { OperatorFlowDetail } from './operator-flow-detail';

/**
 * Both fixtures were captured verbatim from a deployed aggregator reading real
 * MxlFlow / MxlReceiver / MxlFlowMirror objects, so the field names, the nulls and
 * the pre-formatted strings ("48 kHz", "Y 1920×1080 @10b") are the aggregator's
 * own rather than a guess at them.
 */
const VIDEO: OperatorFlow = {
  id: 'd4000000-0000-0000-0000-000000000001',
  label: 'ST2110-Cam-1',
  description: 'Camera 1 via the ST 2110 gateway',
  format: 'video',
  mediaType: 'video/v210',
  resolution: '1920x1080',
  rate: '50/1',
  channels: null,
  colorspace: 'BT709',
  grouphint: 'Studio A:CAM1',
  originFresh: true,
  originReason: 'LeaseRenewed',
  originNode: 'mxl-ui-verify-worker',
  originAge: 6,
  locations: [
    { node: 'mxl-ui-verify-worker', phase: 'Origin', observedAge: 245 },
    { node: 'mxl-ui-verify-control-plane', phase: 'Ready', observedAge: 249 },
  ],
  detail: {
    created: '2026-07-30T08:11:05Z',
    createdAge: 356,
    description: 'Camera 1 via the ST 2110 gateway',
    media: {
      mediaType: 'video/v210',
      colorspace: 'BT709',
      interlaceMode: 'progressive',
      bitDepth: 10,
      channels: null,
      components: ['Y 1920×1080 @10b', 'Cb 960×1080 @10b', 'Cr 960×1080 @10b'],
      grainRate: '50/1',
      fps: 50.0,
      width: 1920,
      height: 1080,
      grainBytes: 5529600,
      nominalMbps: 2212,
    },
    parents: [],
    tags: { 'urn:x-nmos:tag:grouphint/v1.0': ['Studio A:CAM1'] },
    conditions: [
      {
        type: 'Ready',
        status: 'True',
        reason: 'FlowMaterialized',
        message: 'flow is readable on 2 nodes',
        age: 2765,
      },
    ],
    receivers: [
      {
        name: 'compositor-cam1',
        namespace: 'mxl-system',
        provider: 'verbs',
        phase: 'Bound',
        pod: 'composite-7d9f4b6c8-xh2kq',
        boundMirror: 'd4000000-0000-0000-0000-000000000001--mxl-ui-verify-worker',
      },
    ],
    mirrors: [
      {
        name: 'd4000000-0000-0000-0000-000000000001--mxl-ui-verify-worker',
        namespace: 'mxl-system',
        sourceNode: 'mxl-ui-verify-worker',
        targetNode: 'mxl-ui-verify-control-plane',
        provider: 'verbs',
        phase: 'Ready',
        attempts: 0,
        lastError: null,
        grainAge: 245,
        requestor: 'compositor-cam1',
        conditions: [
          {
            type: 'Ready',
            status: 'True',
            reason: 'Transferring',
            message: 'RDMA transfer healthy',
            age: 2645,
          },
        ],
      },
    ],
  },
};

const AUDIO: OperatorFlow = {
  id: 'b3bb5be7-0000-0000-0000-000000000004',
  label: 'Audio-Bed-48k',
  format: 'audio',
  mediaType: 'audio/L24',
  rate: '48 kHz',
  channels: 8,
  originFresh: false,
  originReason: 'LeaseExpired',
  originNode: 'mxl-ui-verify-worker',
  originAge: 688,
  locations: [{ node: 'mxl-ui-verify-worker', phase: 'Origin', observedAge: 12 }],
  detail: {
    createdAge: 60,
    media: {
      mediaType: 'audio/L24',
      colorspace: null,
      interlaceMode: null,
      bitDepth: 24,
      channels: 8,
      components: [],
      sampleRate: '48 kHz',
    },
    parents: [],
    tags: {},
    conditions: [],
    receivers: [],
    mirrors: [],
  },
};

/** A flow the operator knows of but nothing has materialised or consumed. */
const BARE: OperatorFlow = {
  id: 'd4000000-0000-0000-0000-000000000003',
  label: 'Mirror-Only-Flow',
  format: 'video',
  originFresh: null,
  originReason: 'NoOrigin',
  originNode: null,
  originAge: null,
  locations: [],
  detail: null,
};

describe('OperatorFlowDetail', () => {
  let fixture: ComponentFixture<OperatorFlowDetail>;

  beforeEach(() => {
    fixture = TestBed.createComponent(OperatorFlowDetail);
  });

  async function render(flow: OperatorFlow) {
    fixture.componentRef.setInput('flow', flow);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const sections = [...el.querySelectorAll('h3')].map((h) => h.textContent!.trim());
    const keys = [...el.querySelectorAll('.kv .k')] as HTMLElement[];
    const vals = [...el.querySelectorAll('.kv .v')] as HTMLElement[];
    // Labels repeat across sections (two "Ready" conditions, for one), so rows are
    // a list rather than a map.
    const rows = keys.map((k, i) => ({
      label: k.textContent!.trim(),
      text: vals[i].querySelector('.vv')!.textContent!.replace(/\s+/g, ' ').trim(),
      state: ['ok', 'bad', 'warn'].find((c) => vals[i].classList.contains(c)) ?? '',
    }));
    const find = (label: string) => rows.find((r) => r.label === label);
    return { sections, rows, find };
  }

  it('renders every section of the control plane view', async () => {
    const { sections } = await render(VIDEO);
    expect(sections).toEqual([
      'Flow',
      'Media',
      'Origin',
      'Locations',
      'Conditions',
      'Receivers',
      'Mirrors (RDMA transfer)',
      'Tags',
    ]);
  });

  it('takes the video media branch', async () => {
    const { find } = await render(VIDEO);
    expect(find('resolution')!.text).toBe('1920×1080');
    expect(find('interlace')!.text).toBe('progressive');
    expect(find('grain size')!.text).toBe('5.27 MiB');
    expect(find('fps')!.text).toBe('50.00');
    expect(find('nominal bitrate')).toMatchObject({ text: '2212 Mbit/s', state: 'warn' });
    expect(find('components')!.text).toContain('Y 1920×1080 @10b');
    // Audio-only rows must not appear.
    expect(find('sample rate')).toBeUndefined();
  });

  it('takes the audio media branch, and quotes no video geometry', async () => {
    const { find } = await render(AUDIO);
    expect(find('sample rate')!.text).toBe('48 kHz');
    expect(find('channels')!.text).toBe('8');
    expect(find('bit depth')!.text).toBe('24-bit');
    expect(find('resolution')).toBeUndefined();
    expect(find('grain size')).toBeUndefined();
    expect(find('nominal bitrate')).toBeUndefined();
  });

  // The three-state origin dot's counterpart in the panel: unknown must not read
  // as broken.
  it('reports origin freshness in three states', async () => {
    expect((await render(VIDEO)).find('origin fresh')).toMatchObject({ text: 'yes', state: 'ok' });
    expect((await render(AUDIO)).find('origin fresh')).toMatchObject({ text: 'no', state: 'bad' });
    expect((await render(BARE)).find('origin fresh')).toMatchObject({
      text: 'unknown',
      state: 'warn',
    });
  });

  it('marks a Stale location bad and an Origin location ok', async () => {
    const stale: OperatorFlow = {
      ...VIDEO,
      locations: [
        { node: 'node-a', phase: 'Origin', observedAge: 3 },
        { node: 'node-b', phase: 'Stale', observedAge: 700 },
      ],
    };
    const { rows } = await render(stale);
    expect(rows.find((r) => r.label === 'node-a')).toMatchObject({ state: 'ok' });
    expect(rows.find((r) => r.label === 'node-b')).toMatchObject({ state: 'bad' });
    expect(rows.find((r) => r.label === 'node-a')!.text).toBe('Origin · seen 3s');
  });

  it('renders receivers and the mirror chain with their ages', async () => {
    const { find } = await render(VIDEO);
    expect(find('compositor-cam1')).toMatchObject({ text: 'Bound · verbs', state: 'ok' });
    expect(find('pod')!.text).toBe('composite-7d9f4b6c8-xh2kq');
    expect(find('mxl-ui-verify-worker → mxl-ui-verify-control-plane')).toMatchObject({
      text: 'Ready · verbs',
      state: 'ok',
    });
    expect(find('last grain')!.text).toBe('4m');
    expect(find('attempts')).toMatchObject({ text: '0', state: '' });
  });

  it('says plainly when nothing is wired to a flow', async () => {
    const { find } = await render(AUDIO);
    expect(find('receivers')).toMatchObject({
      text: 'none — nobody is consuming this flow',
      state: 'warn',
    });
    expect(find('mirrors')).toMatchObject({
      text: 'none — read locally, no cross-node transfer',
      state: 'warn',
    });
    expect(find('conditions')).toMatchObject({ text: 'none written', state: 'warn' });
    expect(find('tags')!.text).toBe('none');
  });

  it('survives a flow with no detail block at all', async () => {
    const { find, sections } = await render(BARE);
    expect(sections).toHaveLength(8);
    expect(find('locations')).toMatchObject({ text: 'not materialized anywhere', state: 'bad' });
    expect(find('media type')!.text).toBe('--');
    expect(find('registered')!.text).toBe('--');
  });

  it('strips the NMOS URN scaffolding off tag names', async () => {
    const { find } = await render(VIDEO);
    // urn:x-nmos:tag:grouphint/v1.0 -> grouphint
    expect(find('grouphint')!.text).toBe('Studio A:CAM1');
  });

  it('surfaces a mirror that is failing, with its last error', async () => {
    const failing: OperatorFlow = {
      ...VIDEO,
      detail: {
        ...VIDEO.detail,
        mirrors: [
          {
            name: 'm1',
            sourceNode: 'node-a',
            targetNode: 'node-b',
            provider: 'verbs',
            phase: 'Failed',
            attempts: 7,
            lastError: 'rdma_connect: connection refused',
            grainAge: null,
            conditions: [],
          },
        ],
      },
    };
    const { find } = await render(failing);
    expect(find('node-a → node-b')).toMatchObject({ text: 'Failed · verbs', state: 'bad' });
    expect(find('attempts')).toMatchObject({ text: '7', state: 'bad' });
    expect(find('last error')).toMatchObject({
      text: 'rdma_connect: connection refused',
      state: 'bad',
    });
    expect(find('last grain')!.text).toBe('--');
  });
});
