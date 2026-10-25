import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import {
  FlowReaderRequest,
  GeneratorReader,
  GeneratorsResponse,
  OperatorFlow,
} from '../../core/api/models';
import { validateFlowReaders } from './generator-validation';

/**
 * Readers of any flows the cluster carries, chosen from the operator flow list:
 * a chart's writers, an SRT ingest, or a generator booked here. Each reader
 * holds every chosen flow open on its node, which mirrors them there.
 *
 * A redundancy set's output is offered beside the flows, though it has no
 * MxlFlow: opening it is what has the set merged on the reader's node.
 */
@Component({
  selector: 'mv-reader-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gwbar">
      <h2>Book a reader</h2>

      <div class="gen-field">
        <label class="gen-label" for="rd-label">Label</label>
        <input
          id="rd-label"
          class="gen-input"
          type="text"
          [value]="label()"
          (input)="label.set(value($event))"
          placeholder="Replica test"
        />
      </div>

      <div class="gen-field">
        <label class="gen-label" for="rd-filter">Flows ({{ chosen().length }} chosen)</label>
        <input
          id="rd-filter"
          class="gen-input"
          type="text"
          [value]="filter()"
          (input)="filter.set(value($event))"
          placeholder="filter by label, group, set or id"
          spellcheck="false"
        />
        <div class="rd-flows">
          @for (flow of shown(); track flow.id) {
            <label class="rd-flow">
              <input
                type="checkbox"
                [checked]="chosen().includes(flow.id)"
                (change)="toggle(flow.id, checked($event))"
              />
              <span class="rd-flow-label">{{ flow.label || flow.id }}</span>
              <span class="badge" [class]="flow.format ?? ''">{{ flow.format ?? '?' }}</span>
              <span class="rd-flow-meta">
                {{ flow.id }}{{ flow.originNode ? ' | on ' + flow.originNode : ''
                }}{{ roles().get(flow.id) ? ' | ' + roles().get(flow.id) : '' }}
              </span>
            </label>
          } @empty {
            <div class="gen-hint">No flow matches.</div>
          }
        </div>
      </div>

      <div class="gen-field">
        <label class="gen-label" for="rd-count">Readers</label>
        <input
          id="rd-count"
          class="gen-input"
          type="number"
          min="1"
          [max]="limits()?.maxCopies ?? 1"
          [value]="count()"
          (input)="count.set(+value($event))"
        />
        <div class="gen-hint">
          Each reader holds every chosen flow open. A reader booked here is not released with a
          generator whose flow it reads; add it from the generator for that.
        </div>
      </div>

      <div class="gen-field">
        <label class="gen-label" for="rd-node">Node</label>
        <input
          id="rd-node"
          class="gen-input gen-mono"
          type="text"
          [value]="node()"
          (input)="node.set(value($event))"
          placeholder="any"
          spellcheck="false"
        />
      </div>

      <div class="gen-field">
        <label class="gen-label" for="rd-provider">Transport</label>
        <select
          id="rd-provider"
          class="gen-select"
          [value]="provider()"
          (change)="provider.set(value($event))"
        >
          @for (p of limits()?.providers ?? ['auto']; track p) {
            <option [value]="p">{{ p }}</option>
          }
        </select>
      </div>

      <div class="gen-field">
        <label class="gen-label" for="rd-ttl">Expires</label>
        <select id="rd-ttl" class="gen-select" [value]="ttl()" (change)="ttl.set(value($event))">
          @for (choice of limits()?.ttls ?? []; track choice) {
            <option [value]="choice">{{ choice === 'none' ? 'never' : 'in ' + choice }}</option>
          }
        </select>
      </div>

      @if (serverError() || (chosen().length ? error() : ''); as text) {
        <div class="gen-errors" aria-live="polite">{{ text }}</div>
      }
      @if (partial(); as text) {
        <div class="gen-errors" aria-live="polite">{{ text }}</div>
      }

      <div class="gen-actions">
        <button class="btn" type="button" [disabled]="!submittable()" (click)="submit()">
          {{ busy() ? 'Booking...' : count() > 1 ? 'Book ' + count() + ' readers' : 'Book reader' }}
        </button>
      </div>
    </div>
  `,
})
export class ReaderForm {
  readonly limits = input<GeneratorsResponse | null>(null);
  readonly created = output<GeneratorReader[]>();

  private readonly api = inject(MetricsApi);
  /** Slower than the flow list's own cadence: a picker only needs the set of flows. */
  private readonly flowList = poll(5000, () => this.api.operatorFlows());

  protected readonly label = signal('');
  protected readonly filter = signal('');
  protected readonly chosen = signal<string[]>([]);
  protected readonly count = signal(1);
  protected readonly node = signal('');
  protected readonly provider = signal('auto');
  protected readonly ttl = signal('1h');
  protected readonly busy = signal(false);
  protected readonly serverError = signal('');
  /**
   * Why the last booking stopped short. An outcome, not a verdict on the
   * fields, so it lasts until the next submit -- in serverError the reset after
   * a booking would clear it at once.
   */
  protected readonly partial = signal('');

  constructor() {
    // A server's complaint is about the values that were sent; editing any of
    // them makes it stale.
    effect(() => {
      this.request();
      untracked(() => this.serverError.set(''));
    });
    // A chosen flow that left the cluster's list would be posted unseen and
    // refused, so it leaves the choice with it.
    effect(() => {
      const list = this.flowList();
      if (!list) return;
      const known = new Set(this.flows().map((f) => f.id));
      untracked(() => this.chosen.update((ids) => ids.filter((id) => known.has(id))));
    });
  }

  /** The inventory's flows and every set's output. */
  private readonly flows = computed<OperatorFlow[]>(() => {
    const list = this.flowList();
    return [...(list?.flows ?? []), ...(list?.sets ?? []).map((set) => set.output)];
  });

  /** What a flow is to a redundancy set, so a member or an output is told apart. */
  protected readonly roles = computed(() => {
    const roles = new Map<string, string>();
    for (const set of this.flowList()?.sets ?? []) {
      roles.set(set.output.id, `output of ${set.name}`);
      set.members.forEach((id, i) => roles.set(id, `member ${i + 1} of ${set.name}`));
    }
    return roles;
  });

  protected readonly shown = computed<OperatorFlow[]>(() => {
    const needle = this.filter().trim().toLowerCase();
    const roles = this.roles();
    const flows = [...this.flows()].sort((a, b) =>
      (a.label || a.id).localeCompare(b.label || b.id),
    );
    if (!needle) return flows;
    // A chosen flow stays in view whatever the filter, so nothing is posted
    // that the picker does not show.
    const chosen = this.chosen();
    return flows.filter(
      (f) =>
        chosen.includes(f.id) ||
        [f.label, f.grouphint, f.id, roles.get(f.id)].some((v) =>
          (v ?? '').toLowerCase().includes(needle),
        ),
    );
  });

  protected readonly request = computed<FlowReaderRequest>(() => ({
    label: this.label(),
    flows: this.chosen(),
    count: this.count(),
    node: this.node().trim(),
    provider: this.provider(),
    ttl: this.ttl(),
  }));

  protected readonly error = computed(() => validateFlowReaders(this.request(), this.limits()));

  protected readonly submittable = computed(() => !this.busy() && !this.error());

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected toggle(id: string, on: boolean): void {
    this.chosen.update((list) => (on ? [...list, id] : list.filter((f) => f !== id)));
  }

  protected submit(): void {
    this.busy.set(true);
    this.serverError.set('');
    this.partial.set('');
    this.api.createFlowReaders(this.request()).subscribe({
      next: (batch) => {
        this.busy.set(false);
        this.created.emit(batch.readers);
        this.partial.set(batch.error ?? '');
        this.chosen.set([]);
        this.label.set('');
      },
      error: (err: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.serverError.set(err.error?.error ?? 'booking failed');
      },
    });
  }
}
