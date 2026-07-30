import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Flow } from '../../core/api/models';
import { FlowDetail } from './flow-detail';

/**
 * Captured verbatim from a deployed aggregator with nothing else running: the
 * sub-objects come back as explicit nulls rather than missing keys, which is the
 * shape the panel has to survive. Anything unresolved must read "--", never 0.
 */
const UNRESOLVED: Flow = {
  n: 1,
  label: 'MXL-1',
  uuid: 'd4d00000-0000-0000-0000-000000000001',
  compositor: {
    fps: 0,
    mbps: 0,
    pushed: null,
    missed: null,
    reading: null,
    measured: false,
    source: 'compositor unreachable',
    live: false,
  },
  media: null,
  writer: null,
  receiver: null,
  mirrors: [],
  flow: null,
};

const HEALTHY: Flow = {
  n: 2,
  label: 'MXL-2',
  uuid: 'd4d00000-0000-0000-0000-000000000002',
  compositor: {
    fps: 50.0,
    mbps: 995,
    pushed: 120345,
    missed: 0,
    reading: true,
    measured: true,
    source: 'compositor',
    live: true,
  },
  media: {
    mediaType: 'video/v210',
    width: 1920,
    height: 1080,
    bitDepth: 10,
    colorspace: 'BT709',
    grainRate: '50/1',
    fps: 50,
    grainBytes: 5529600,
    nominalMbps: 2212,
  },
  writer: {
    pod: 'writer-mxl-2-7d9f',
    node: 'ip-10-0-1-23',
    phase: 'Running',
    ready: true,
    restarts: 0,
    started: new Date(Date.now() - 3600_000).toISOString(),
    image: 'ghcr.io/qvest-digital/mxl-dmf-writer:e5cf194',
    pattern: 'smpte',
    overlayFormat: 'I420',
  },
  receiver: { name: 'rx-2', provider: 'verbs', phase: 'Bound', boundMirror: 'm-2' },
  mirrors: [
    { name: 'gw--node-a--node-b', phase: 'Ready', sourceNode: 'node-a', provider: 'verbs' },
  ],
  flow: {
    originFresh: 'True',
    originReason: 'LeaseRenewed',
    locations: [{ node: 'node-a', phase: 'Origin' }],
  },
};

describe('FlowDetail', () => {
  let fixture: ComponentFixture<FlowDetail>;

  beforeEach(() => {
    fixture = TestBed.createComponent(FlowDetail);
  });

  /** Every row as `label -> value`, plus the state class the value carries. */
  async function rows(flow: Flow) {
    fixture.componentRef.setInput('flow', flow);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;
    const keys = [...el.querySelectorAll('.kv .k')] as HTMLElement[];
    const vals = [...el.querySelectorAll('.kv .v')] as HTMLElement[];
    const out = new Map<string, { text: string; state: string }>();
    keys.forEach((k, i) => {
      const v = vals[i];
      out.set(k.textContent!.trim(), {
        text: v.querySelector('.vv')!.textContent!.replace(/\s+/g, ' ').trim(),
        state: ['ok', 'bad', 'warn'].find((c) => v.classList.contains(c)) ?? '',
      });
    });
    return out;
  }

  it('renders all five sections', async () => {
    await rows(HEALTHY);
    const headings = [...fixture.nativeElement.querySelectorAll('h3')].map((h: HTMLElement) =>
      h.textContent!.trim(),
    );
    expect(headings).toEqual([
      'Media',
      'Writer pod',
      'Compositor (RDMA receive)',
      'Receiver / mirror (gateway)',
      'Flow origin',
    ]);
  });

  it('survives a payload where nothing resolved, showing -- not 0', async () => {
    const r = await rows(UNRESOLVED);
    expect(r.get('grain format')!.text).toBe('--');
    expect(r.get('resolution')!.text).toBe('--');
    expect(r.get('node')!.text).toBe('--');
    expect(r.get('pod')!.text).toBe('');
    expect(r.get('uptime')!.text).toBe('--');
    expect(r.get('restarts')!.text).toBe('--');
    expect(r.get('grain size')!.text).toBe('--');
    expect(r.get('nominal bitrate')!.text).toBe('--');
    expect(r.get('mirror')!.text).toBe('--');
    expect(r.get('locations')!.text).toBe('--');
    // The uuid is the one thing that is always known.
    expect(r.get('uuid')!.text).toBe('d4d00000-0000-0000-0000-000000000001');
  });

  it('names the source instead of letting a frozen grains/s read as a measurement', async () => {
    const unresolved = await rows(UNRESOLVED);
    expect(unresolved.get('source')).toEqual({
      text: 'nominal · compositor unreachable',
      state: 'warn',
    });
    const healthy = await rows(HEALTHY);
    expect(healthy.get('source')).toEqual({ text: 'measured', state: 'ok' });
  });

  it('distinguishes "not reading" from "we cannot tell"', async () => {
    // reading: null means the compositor's stats server was unreachable, which is
    // not the same as it telling us it has stopped reading.
    expect((await rows(UNRESOLVED)).get('reading')).toEqual({ text: '--', state: '' });
    expect((await rows(HEALTHY)).get('reading')).toEqual({ text: 'yes', state: 'ok' });
  });

  it('renders the writer pod and formats its numbers', async () => {
    const r = await rows(HEALTHY);
    expect(r.get('node')).toEqual({ text: 'ip-10-0-1-23', state: 'ok' });
    expect(r.get('phase')).toEqual({ text: 'Running', state: 'ok' });
    expect(r.get('ready')).toEqual({ text: 'yes', state: 'ok' });
    expect(r.get('restarts')).toEqual({ text: '0', state: '' });
    expect(r.get('uptime')!.text).toBe('60m');
    // The registry prefix is never the interesting part of an image ref.
    expect(r.get('image')!.text).toBe('mxl-dmf-writer:e5cf194');
  });

  it('derives media facts from the flow definition', async () => {
    const r = await rows(HEALTHY);
    expect(r.get('resolution')!.text).toBe('1920×1080');
    expect(r.get('bit depth')!.text).toBe('10-bit');
    expect(r.get('fps')!.text).toBe('50.00');
    expect(r.get('grain size')!.text).toBe('5.27 MiB');
    // Arithmetic, not a measurement — dimmed so it reads as a property.
    expect(r.get('nominal bitrate')).toEqual({ text: '2212 Mbit/s', state: 'warn' });
  });

  it('flags v210 overlay blending as the expensive path', async () => {
    expect((await rows(HEALTHY)).get('overlay blend')).toEqual({ text: 'I420', state: 'ok' });
    const v210 = { ...HEALTHY, writer: { ...HEALTHY.writer, overlayFormat: 'v210' } };
    expect((await rows(v210)).get('overlay blend')).toEqual({ text: 'v210', state: 'bad' });
  });

  // /api/flows ships the raw MxlFlow condition status, so this is the string
  // 'True' — not a boolean. Reading it as one would mark every flow stale.
  it('reads originFresh as the condition string it actually is', async () => {
    expect((await rows(HEALTHY)).get('origin fresh')).toEqual({ text: 'yes', state: 'ok' });
    const stale = { ...HEALTHY, flow: { ...HEALTHY.flow, originFresh: 'False' } };
    expect((await rows(stale)).get('origin fresh')).toEqual({ text: 'no', state: 'bad' });
  });

  it('summarises the mirror chain', async () => {
    expect((await rows(HEALTHY)).get('mirror')!.text).toBe('node-a→node-b Ready (verbs)');
    expect((await rows(HEALTHY)).get('locations')!.text).toBe('node-a:Origin');
  });

  it('marks dropped grains', async () => {
    expect((await rows(HEALTHY)).get('grains dropped')).toEqual({ text: '0', state: '' });
    const dropping = { ...HEALTHY, compositor: { ...HEALTHY.compositor, missed: 12 } };
    expect((await rows(dropping)).get('grains dropped')).toEqual({ text: '12', state: 'bad' });
  });
});
