import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import {
  MonitorFlow,
  MonitorReader,
  MonitorResponse,
  ReaderFlowStatus,
} from '../../core/api/models';
import {
  COUNTERS,
  CounterSpec,
  Counts,
  MonitorEvent,
  STATE_LABELS,
  baselineFor,
  countsOf,
  diffEvents,
  flowKey,
  ratePerSecond,
  since,
  sparkline,
} from './monitor-state';

/** Polls kept per flow for its rate and sparkline: two minutes at 2 s. */
const HISTORY = 60;
const FEED = 200;
/** How long a flow shows a problem after its counter last rose. */
const RECENT_MS = 10_000;

interface FlowView {
  key: string;
  status: ReaderFlowStatus;
  flow: MonitorFlow | null;
  label: string;
  counters: { spec: CounterSpec; value: number }[];
  rate: number;
  spark: string;
  problem: boolean;
  /** Dot colour: what the flow is doing now, not what it did since boot. */
  cls: 'live' | 'warn' | 'bad' | '';
  replication: string;
  replicationBad: boolean;
}

interface ReaderView {
  reader: MonitorReader;
  node: string;
  restarts: number;
  flows: FlowView[];
  /** The flows are the last the reader reported before it stopped answering. */
  stale: boolean;
  cls: 'live' | 'warn' | 'bad' | '';
}

/**
 * Every reader on the cluster at a glance, for load and failure tests: what
 * each flow delivers, every way a read went wrong, and the replication that
 * carries the flow to the reader's node. Counters show what happened since the
 * test started, so a run reads on its own; the feed lists every rise as it
 * lands.
 */
@Component({
  selector: 'mv-monitor-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './monitor-page.html',
})
export class MonitorPage {
  private readonly api = inject(MetricsApi);
  protected readonly data = poll(2000, () => this.api.monitor());

  /** Counters as they stood when the test started; null counts from boot. */
  protected readonly baseline = signal<Counts | null>(null);
  protected readonly startedAt = signal<number | null>(null);
  protected readonly problemsOnly = signal(false);
  protected readonly events = signal<MonitorEvent[]>([]);
  /** ok counter samples per flow, oldest first. */
  private readonly history = signal<Record<string, { at: number; value: number }[]>>({});
  /**
   * Each reader's flows as it last reported them. A reader that stops
   * answering keeps its last counts on the page, marked stale, so a killed pod
   * does not make the test's problem count go down.
   */
  private readonly lastKnown = signal<Record<string, ReaderFlowStatus[]>>({});
  /** When each flow last had a warning or a bad counter rise. */
  private readonly recent = signal<Record<string, { warn: number; bad: number }>>({});
  private previous: MonitorResponse | null = null;

  constructor() {
    effect(() => {
      const data = this.data();
      if (!data) return;
      const now = Date.now();
      untracked(() => {
        const fresh = diffEvents(this.previous, data, now);
        if (fresh.length) {
          this.events.update((list) => [...[...fresh].reverse(), ...list].slice(0, FEED));
          this.recent.update((all) => {
            const live = new Set(Object.keys(countsOf(data)));
            // Flows that are gone take their marks with them.
            const next = Object.fromEntries(Object.entries(all).filter(([key]) => live.has(key)));
            for (const e of fresh) {
              const key = flowKey(e.reader, e.flow);
              const seen = next[key] ?? { warn: 0, bad: 0 };
              if (e.severity === 'warn' || e.severity === 'bad') {
                next[key] = { ...seen, [e.severity]: now };
              }
            }
            return next;
          });
        }
        this.previous = data;
        this.lastKnown.update((all) => {
          const next: Record<string, ReaderFlowStatus[]> = {};
          for (const r of data.readers) {
            const flows = r.status?.flows ?? all[r.name];
            if (flows) next[r.name] = flows;
          }
          return next;
        });
        const counts = countsOf(data);
        this.history.update((all) => {
          const next: Record<string, { at: number; value: number }[]> = {};
          for (const [key, c] of Object.entries(counts)) {
            next[key] = [...(all[key] ?? []), { at: now, value: c['ok'] }].slice(-HISTORY - 1);
          }
          return next;
        });
      });
    });
  }

  protected readonly readers = computed<ReaderView[]>(() => {
    const data = this.data();
    const base = this.baseline();
    const history = this.history();
    const recent = this.recent();
    const lastKnown = this.lastKnown();
    const now = Date.now();
    return (data?.readers ?? []).map((reader) => {
      const node = reader.pods.map((p) => p.node).find(Boolean) ?? '';
      const stale = !reader.status && !!lastKnown[reader.name];
      const flows = (reader.status?.flows ?? lastKnown[reader.name] ?? []).map((status) =>
        this.flowView(
          reader,
          status,
          data?.flows[status.id] ?? null,
          node,
          base,
          history,
          recent,
          now,
        ),
      );
      // The reader shows its worst flow.
      const worst = (['bad', 'warn', '', 'live'] as const).find((c) =>
        flows.some((f) => f.cls === c),
      );
      return {
        reader,
        node,
        restarts: reader.pods.reduce((n, p) => n + (p.restarts ?? 0), 0),
        flows,
        stale,
        cls: reader.statusError ? 'bad' : (worst ?? ''),
      };
    });
  });

  protected readonly shown = computed(() =>
    this.problemsOnly()
      ? this.readers()
          .map((r) => ({ ...r, flows: r.flows.filter((f) => f.problem) }))
          .filter((r) => r.flows.length || r.reader.statusError)
      : this.readers(),
  );

  /** Totals over every flow, for the tiles across the top. */
  protected readonly totals = computed(() => {
    const flows = this.readers().flatMap((r) => r.flows);
    const byClass = new Map<string, { spec: CounterSpec; value: number }>();
    for (const f of flows) {
      for (const c of f.counters) {
        const t = byClass.get(c.spec.key) ?? { spec: c.spec, value: 0 };
        t.value += c.value;
        byClass.set(c.spec.key, t);
      }
    }
    const mirrors = Object.values(this.data()?.flows ?? {}).flatMap((f) => f.mirrors);
    return {
      readers: this.readers().length,
      flows: flows.length,
      delivering: flows.filter((f) => f.status.delivering).length,
      grains: flows.filter((f) => f.status.unit === 'grains').reduce((n, f) => n + f.rate, 0),
      samples: flows.filter((f) => f.status.unit === 'samples').reduce((n, f) => n + f.rate, 0),
      problems: [...byClass.values()]
        .filter((c) => c.spec.severity !== 'ok')
        .reduce((n, c) => n + c.value, 0),
      classes: COUNTERS.map((spec) => byClass.get(spec.key) ?? { spec, value: 0 }),
      mirrors: mirrors.length,
      mirrorsReady: mirrors.filter((m) => m.phase === 'Ready').length,
    };
  });

  protected readonly elapsed = computed(() => {
    const at = this.startedAt();
    this.data();
    if (at === null) return '';
    const s = Math.floor((Date.now() - at) / 1000);
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  });

  protected startTest(): void {
    this.baseline.set(countsOf(this.data()));
    this.startedAt.set(Date.now());
    this.events.set([]);
  }

  protected clearTest(): void {
    this.baseline.set(null);
    this.startedAt.set(null);
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected stateLabel(state: string): string {
    return STATE_LABELS[state] ?? state;
  }

  protected time(at: number): string {
    return new Date(at).toLocaleTimeString([], { hour12: false });
  }

  protected rateText(rate: number, unit: string | null): string {
    const n = rate >= 10000 ? `${(rate / 1000).toFixed(1)}k` : rate.toFixed(rate >= 100 ? 0 : 1);
    return `${n} ${unit ?? 'reads'}/s`;
  }

  private flowView(
    reader: MonitorReader,
    status: ReaderFlowStatus,
    flow: MonitorFlow | null,
    node: string,
    base: Counts | null,
    history: Record<string, { at: number; value: number }[]>,
    recent: Record<string, { warn: number; bad: number }>,
    now: number,
  ): FlowView {
    const key = flowKey(reader.name, status.id);
    const current = countsOf({ readers: [{ ...reader, status: { flows: [status] } }], flows: {} })[
      key
    ];
    const flowBase = baselineFor(current, base?.[key]);
    const counters = COUNTERS.map((spec) => ({
      spec,
      value: since(spec.read(status), flowBase?.[spec.key]),
    }));
    const samples = history[key] ?? [];
    const rates = samples
      .slice(1)
      .map((s, i) =>
        Math.max(0, (s.value - samples[i].value) / ((s.at - samples[i].at) / 1000 || 1)),
      );
    const mirror = (flow?.mirrors ?? []).find((m) => !node || m.targetNode === node);
    let replication = 'no origin known';
    let replicationBad = false;
    if (flow?.originNode && node && flow.originNode === node) {
      replication = `local: read on its origin node ${node}`;
    } else if (mirror) {
      const attempts = mirror.attempts
        ? `, ${mirror.attempts} attempt${mirror.attempts === 1 ? '' : 's'}`
        : '';
      replication = `${mirror.sourceNode ?? '?'} -> ${mirror.targetNode ?? '?'} over ${mirror.provider ?? '?'}, ${mirror.phase ?? 'no phase'}${attempts}${mirror.lastError ? `: ${mirror.lastError}` : ''}`;
      replicationBad = mirror.phase !== 'Ready' || !!mirror.lastError;
    } else if (flow?.originNode) {
      replication = `origin ${flow.originNode}, no mirror to ${node || 'this node'}`;
      replicationBad = status.state !== 'open';
    }
    const seen = recent[key];
    const cls: FlowView['cls'] =
      status.state !== 'open' || status.formatMismatch || (seen && now - seen.bad < RECENT_MS)
        ? 'bad'
        : replicationBad || (seen && now - seen.warn < RECENT_MS)
          ? 'warn'
          : status.delivering
            ? 'live'
            : '';
    return {
      key,
      cls,
      status,
      flow,
      label: flow?.label && flow.label !== status.id ? flow.label : status.mediaType || 'flow',
      counters,
      rate: ratePerSecond(samples.slice(-6)),
      spark: sparkline(rates, 120, 28),
      problem:
        status.state !== 'open' ||
        !status.delivering ||
        !!status.formatMismatch ||
        replicationBad ||
        counters.some((c) => c.spec.severity !== 'ok' && c.value > 0),
      replication,
      replicationBad,
    };
  }
}
