import { MonitorResponse, ReaderFlowStatus } from '../../core/api/models';
import {
  baselineFor,
  countsOf,
  diffEvents,
  ratePerSecond,
  since,
  sparkline,
} from './monitor-state';

function flow(
  over: Partial<ReaderFlowStatus> = {},
  reads: Partial<ReaderFlowStatus['reads']> = {},
): ReaderFlowStatus {
  return {
    id: 'd4d00000-0000-0000-0000-000000000001',
    state: 'open',
    delivering: true,
    unit: 'grains',
    mediaType: 'video/v210',
    format: '1920x1080 @ 50/1',
    formatMismatch: '',
    ageSeconds: 0.001,
    reads: {
      ok: 100,
      too_early: 0,
      too_late: 0,
      missing: 0,
      invalid: 0,
      incomplete: 0,
      wrong_size: 0,
      wrong_format: 0,
      illegal_values: 0,
      permission_error: 0,
      other_error: 0,
      ...reads,
    },
    openFailures: { domain: 0, not_found: 0, permission: 0, other: 0 },
    skipped: 0,
    stalls: 0,
    opens: 1,
    lost: 0,
    lastError: null,
    ...over,
  };
}

function data(...flows: ReaderFlowStatus[]): MonitorResponse {
  return {
    readers: [{ name: 'reader-1', pods: [], status: { flows }, statusError: null }],
    flows: {},
  };
}

/**
 * The feed is what a failure test watches: every rise of a problem counter and
 * every state change has to appear, and correct reads never.
 */
describe('monitor state', () => {
  it('reports nothing on the first poll, which has nothing to compare with', () => {
    expect(diffEvents(null, data(flow()), 0)).toEqual([]);
  });

  it('reports every problem counter that rose, by how much, with the last error', () => {
    const events = diffEvents(
      data(flow()),
      data(
        flow(
          { lastError: { message: 'illegal sample value', secondsAgo: 0 } },
          { ok: 150, too_late: 2, illegal_values: 3 },
        ),
      ),
      5,
    );
    expect(events.map((e) => [e.severity, e.text])).toEqual([
      ['warn', 'too late +2: illegal sample value'],
      ['bad', 'illegal values +3: illegal sample value'],
    ]);
  });

  it('never reports correct reads', () => {
    expect(diffEvents(data(flow()), data(flow({}, { ok: 500 })), 1)).toEqual([]);
  });

  it('reports a state change, and a recovery as good news', () => {
    const lost = diffEvents(data(flow()), data(flow({ state: 'flow_not_found' })), 1);
    expect(lost[0]).toEqual(
      expect.objectContaining({ severity: 'bad', text: 'open -> flow not found' }),
    );
    const back = diffEvents(data(flow({ state: 'flow_not_found' })), data(flow()), 2);
    expect(back[0].severity).toBe('ok');
  });

  it('names the last error only when it explains this rise', () => {
    const old = diffEvents(
      data(flow()),
      data(
        flow(
          { lastError: { message: 'flow not found in the domain', secondsAgo: 40 } },
          { too_late: 1 },
        ),
      ),
      1,
    );
    expect(old[0].text).toBe('too late +1');
  });

  it('reports a reader that stops answering, and one that answers again', () => {
    const silent: MonitorResponse = {
      readers: [{ name: 'reader-1', pods: [], status: null, statusError: 'no answer within 2 s' }],
      flows: {},
    };
    expect(diffEvents(data(flow()), silent, 1)).toEqual([
      expect.objectContaining({ severity: 'bad', text: 'no answer within 2 s', flow: '' }),
    ]);
    expect(diffEvents(silent, data(flow()), 2)[0]).toEqual(
      expect.objectContaining({ severity: 'ok', text: 'answering again' }),
    );
  });

  it('drops the whole baseline of a flow whose reader restarted', () => {
    const base = { opens: 3, ok: 1000, too_late: 5 };
    expect(baselineFor({ opens: 3, ok: 1200, too_late: 9 }, base)).toBe(base);
    // Restarted: opens back to 1, even though too_late already climbed past 5.
    expect(baselineFor({ opens: 1, ok: 1100, too_late: 9 }, base)).toBeUndefined();
  });

  it('counts from the test start, and from zero again after a reader restart', () => {
    expect(since(120, 100)).toBe(20);
    expect(since(5, 100)).toBe(5);
    expect(since(7, undefined)).toBe(7);
  });

  it('keys counters by reader and flow', () => {
    expect(
      countsOf(data(flow({}, { too_early: 4 })))['reader-1/d4d00000-0000-0000-0000-000000000001'][
        'too_early'
      ],
    ).toBe(4);
  });

  it('turns counter samples into a rate per second', () => {
    expect(
      ratePerSecond([
        { at: 0, value: 0 },
        { at: 2000, value: 100 },
      ]),
    ).toBe(50);
    expect(
      ratePerSecond([
        { at: 0, value: 100 },
        { at: 2000, value: 10 },
      ]),
    ).toBe(0);
  });

  it('scales a sparkline into its box', () => {
    expect(sparkline([0, 10], 100, 20)).toBe('0.0,19.0 100.0,1.0');
    expect(sparkline([5], 100, 20)).toBe('');
  });
});
