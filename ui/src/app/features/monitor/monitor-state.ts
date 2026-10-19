import { MonitorResponse, ReaderFlowStatus } from '../../core/api/models';

/** How bad a counted outcome is, which decides its colour. */
export type Severity = 'ok' | 'warn' | 'bad';

/** One counter the page shows per flow, where it lives in a status, and how bad it is. */
export interface CounterSpec {
  key: string;
  label: string;
  severity: Severity;
  read: (flow: ReaderFlowStatus) => number;
}

/**
 * Every counter a reader keeps, in the order the page lists them. Timing
 * trouble is a warning: data that arrives late or is overtaken is still the
 * right data. A flow that cannot be reached, or carries the wrong thing, is bad.
 */
export const COUNTERS: CounterSpec[] = [
  { key: 'ok', label: 'ok', severity: 'ok', read: (f) => f.reads.ok },
  { key: 'too_early', label: 'too early', severity: 'warn', read: (f) => f.reads.too_early },
  { key: 'too_late', label: 'too late', severity: 'warn', read: (f) => f.reads.too_late },
  { key: 'skipped', label: 'skipped', severity: 'warn', read: (f) => f.skipped },
  { key: 'stalls', label: 'stalls', severity: 'warn', read: (f) => f.stalls },
  { key: 'lost', label: 'flow lost', severity: 'warn', read: (f) => f.lost },
  { key: 'invalid', label: 'invalid', severity: 'bad', read: (f) => f.reads.invalid },
  { key: 'incomplete', label: 'incomplete', severity: 'bad', read: (f) => f.reads.incomplete },
  { key: 'wrong_size', label: 'wrong size', severity: 'bad', read: (f) => f.reads.wrong_size },
  {
    key: 'wrong_format',
    label: 'wrong format',
    severity: 'bad',
    read: (f) => f.reads.wrong_format,
  },
  {
    key: 'illegal_values',
    label: 'illegal values',
    severity: 'bad',
    read: (f) => f.reads.illegal_values,
  },
  {
    key: 'permission_error',
    label: 'read refused',
    severity: 'bad',
    read: (f) => f.reads.permission_error,
  },
  { key: 'other_error', label: 'read error', severity: 'bad', read: (f) => f.reads.other_error },
  {
    key: 'open_domain',
    label: 'domain unavailable',
    severity: 'bad',
    read: (f) => f.openFailures.domain,
  },
  {
    key: 'open_not_found',
    label: 'flow not found',
    severity: 'bad',
    read: (f) => f.openFailures.not_found,
  },
  {
    key: 'open_permission',
    label: 'open refused',
    severity: 'bad',
    read: (f) => f.openFailures.permission,
  },
  { key: 'open_other', label: 'open error', severity: 'bad', read: (f) => f.openFailures.other },
];

/** Plain words for a reader's state. */
export const STATE_LABELS: Record<string, string> = {
  starting: 'starting',
  domain_unavailable: 'domain unavailable',
  flow_not_found: 'flow not found',
  permission_denied: 'permission denied',
  flow_error: 'flow error',
  open: 'open',
};

/** Counters by flow key, `<reader>/<flow id>`, then counter key. */
export type Counts = Record<string, Record<string, number>>;

export function flowKey(reader: string, flow: string): string {
  return `${reader}/${flow}`;
}

/** Every counter of every flow in a monitor response. */
export function countsOf(data: MonitorResponse | null): Counts {
  const out: Counts = {};
  for (const reader of data?.readers ?? []) {
    for (const flow of reader.status?.flows ?? []) {
      const counts: Record<string, number> = {};
      for (const c of COUNTERS) counts[c.key] = c.read(flow);
      out[flowKey(reader.name, flow.id)] = counts;
    }
  }
  return out;
}

/** A counter less what it stood at when the test started. A counter that went
 *  down belongs to a reader that restarted, so it counts from zero again. */
export function since(now: number, base: number | undefined): number {
  return base === undefined || now < base ? now : now - base;
}

export interface MonitorEvent {
  at: number;
  reader: string;
  flow: string;
  severity: Severity;
  text: string;
}

/**
 * What changed between two polls, as lines for the event feed: every problem
 * counter that rose, by how much, and every flow that changed state. A flow's
 * first appearance is not news, so nothing is reported without a previous poll.
 */
export function diffEvents(
  prev: MonitorResponse | null,
  next: MonitorResponse,
  at: number,
): MonitorEvent[] {
  if (!prev) return [];
  const before = countsOf(prev);
  const states = new Map<string, string>();
  for (const reader of prev.readers) {
    for (const flow of reader.status?.flows ?? [])
      states.set(flowKey(reader.name, flow.id), flow.state);
  }
  const out: MonitorEvent[] = [];
  for (const reader of next.readers) {
    for (const flow of reader.status?.flows ?? []) {
      const key = flowKey(reader.name, flow.id);
      const old = before[key];
      const was = states.get(key);
      if (was !== undefined && was !== flow.state) {
        out.push({
          at,
          reader: reader.name,
          flow: flow.id,
          severity: flow.state === 'open' ? 'ok' : 'bad',
          text: `${STATE_LABELS[was] ?? was} -> ${STATE_LABELS[flow.state] ?? flow.state}`,
        });
      }
      if (!old) continue;
      for (const c of COUNTERS) {
        if (c.severity === 'ok') continue;
        const delta = c.read(flow) - (old[c.key] ?? 0);
        if (delta > 0) {
          out.push({
            at,
            reader: reader.name,
            flow: flow.id,
            severity: c.severity,
            text: `${c.label} +${delta}${flow.lastError ? `: ${flow.lastError.message}` : ''}`,
          });
        }
      }
    }
  }
  return out;
}

/** Per-second rate of `key` over the samples kept for one flow. */
export function ratePerSecond(samples: { at: number; value: number }[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const seconds = (last.at - first.at) / 1000;
  const delta = last.value - first.value;
  return seconds > 0 && delta >= 0 ? delta / seconds : 0;
}

/** The points of a sparkline over per-interval rates, scaled into a w x h box. */
export function sparkline(values: number[], w: number, h: number): string {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  const step = w / (values.length - 1);
  return values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`)
    .join(' ');
}
