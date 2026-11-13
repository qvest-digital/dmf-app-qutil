import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import {
  NoisyNeighbour,
  NoisyPairRequest,
  NoisyRequest,
  NoisyShared,
  NoisySide,
} from '../../core/api/models';
import { validateNoisy, validateNoisyPair } from './noisy-validation';

/** Where one claim goes and what it reserves. */
function sideForm(key: string, title: string) {
  return {
    key,
    title,
    /** any | node | victim. */
    mode: signal('any'),
    node: signal(''),
    victim: signal(''),
    cpu: signal(''),
    memory: signal(''),
  };
}

type SideForm = ReturnType<typeof sideForm>;

/** The role select's value for booking a sink and a sender together. */
const PAIR = 'pair';

/**
 * Booking noisy-neighbour load generators beside a booking or on a node: the
 * form on the left, what it booked on the right.
 *
 * The function serves its own UI and API, and the load is set there. This page
 * books, links that UI and releases; it never drives an engine. A pair books a
 * sink first and gives the sender the address the sink's claim publishes, so
 * the server answers it only once both exist.
 */
@Component({
  selector: 'mv-noisy-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './noisy-page.html',
})
export class NoisyPage {
  private readonly api = inject(MetricsApi);

  /** Same cadence as the other booking pages: a claim's phase moves in seconds. */
  protected readonly data = poll(3000, () => this.api.noisy());

  protected readonly enabled = computed(() => this.data()?.enabled !== false);
  protected readonly listError = computed(() => this.data()?.error ?? '');
  protected readonly nodes = computed(() => this.data()?.nodes ?? []);
  protected readonly victims = computed(() => this.data()?.victims ?? []);
  protected readonly roles = computed(() => [...(this.data()?.roles ?? []), PAIR]);
  protected readonly optInChoices = computed(() => this.data()?.optIns ?? []);
  protected readonly ttls = computed(() => this.data()?.ttls ?? []);

  protected readonly role = signal('aggressor');
  protected readonly label = signal('');
  protected readonly ttl = signal('1h');
  protected readonly peer = signal('');
  protected readonly storageOn = signal(false);
  protected readonly storageSize = signal('20Gi');
  protected readonly gpuOn = signal(false);
  protected readonly fabricOn = signal(false);
  /** none | networks | host. */
  protected readonly fabricVia = signal('none');
  protected readonly networks = signal('');
  protected readonly rdmaDevice = signal('');
  protected readonly rdmaGidIndex = signal('');
  protected readonly maxDuration = signal('15m');
  protected readonly optIns = signal<string[]>([]);
  protected readonly routed = signal(true);

  private readonly one = sideForm('one', '');
  private readonly sink = sideForm('sink', 'Sink');
  private readonly sender = sideForm('sender', 'Sender');

  protected readonly isPair = computed(() => this.role() === PAIR);
  protected readonly sides = computed(() =>
    this.isPair() ? [this.sink, this.sender] : [this.one],
  );
  /** The engines that need storage and a GPU run on an aggressor only. */
  protected readonly aggressor = computed(() => this.role() === 'aggressor');
  protected readonly network = computed(() => this.role() !== 'aggressor');

  protected readonly submitting = signal(false);
  protected readonly formError = signal('');
  protected readonly deleteError = signal('');

  private readonly fresh = signal<NoisyNeighbour[]>([]);
  private readonly deleting = signal<string[]>([]);

  /** Booked claims, with anything created since the last poll in front. */
  protected readonly booked = computed(() => {
    const polled = this.data()?.noisy ?? [];
    const names = new Set(polled.map((n) => n.name));
    return [...this.fresh().filter((n) => !names.has(n.name)), ...polled];
  });

  /** Sinks a sender may target. */
  protected readonly sinks = computed(() =>
    this.booked().filter((n) => n.role === 'sink' && !n.deleting),
  );

  protected readonly full = computed(() => {
    const max = this.data()?.max ?? 0;
    return max > 0 && this.booked().length + (this.isPair() ? 2 : 1) > max;
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected isDeleting(name: string): boolean {
    return this.deleting().includes(name);
  }

  protected toggleOptIn(name: string, on: boolean): void {
    this.optIns.update((list) => (on ? [...list, name] : list.filter((o) => o !== name)));
  }

  private side(form: SideForm): NoisySide {
    const out: NoisySide = {};
    if (form.mode() === 'node' && form.node()) out.placement = { nodeName: form.node() };
    if (form.mode() === 'victim' && form.victim()) out.placement = { victim: form.victim() };
    const cpu = form.cpu().trim();
    const memory = form.memory().trim();
    if (cpu || memory) {
      out.resources = { requests: {} };
      if (cpu) out.resources.requests.cpu = cpu;
      if (memory) out.resources.requests.memory = memory;
    }
    return out;
  }

  private shared(): NoisyShared {
    const out: NoisyShared = {
      label: this.label().trim(),
      ttl: this.ttl(),
      limits: { maxDuration: this.maxDuration().trim(), optIns: this.optIns() },
      ingress: { httproute: { enabled: this.routed() } },
    };
    if (this.network() && this.fabricOn()) {
      out.fabric = { enabled: true };
      if (this.fabricVia() === 'networks') out.fabric.networks = this.networks().trim();
      if (this.fabricVia() === 'host') out.fabric.hostNetwork = true;
      const device = this.rdmaDevice().trim();
      const gid = this.rdmaGidIndex().trim();
      if (device || gid) {
        out.network = {};
        if (device) out.network.rdmaDevice = device;
        if (gid) out.network.rdmaGidIndex = Number(gid);
      }
    }
    return out;
  }

  /** The request the form describes, either shape. */
  private request(): { pair: NoisyPairRequest } | { one: NoisyRequest } {
    if (this.isPair()) {
      return {
        pair: { ...this.shared(), sink: this.side(this.sink), sender: this.side(this.sender) },
      };
    }
    const one: NoisyRequest = { ...this.shared(), ...this.side(this.one), role: this.role() };
    if (this.role() === 'sender') one.peer = this.peer();
    if (this.aggressor() && this.storageOn()) {
      one.storage = { enabled: true, size: this.storageSize().trim() };
    }
    if (this.aggressor() && this.gpuOn()) one.gpu = { enabled: true };
    return { one };
  }

  protected book(event: Event): void {
    event.preventDefault();
    this.formError.set('');
    const req = this.request();
    const bad =
      'pair' in req
        ? validateNoisyPair(req.pair, this.data())
        : validateNoisy(req.one, this.data());
    if (bad) return this.formError.set(bad);

    this.submitting.set(true);
    const done = (rows: NoisyNeighbour[]) => {
      this.submitting.set(false);
      this.fresh.update((list) => [...rows, ...list]);
      this.label.set('');
    };
    const failed = (err: { error?: { error?: string } }) => {
      this.submitting.set(false);
      this.formError.set(err.error?.error ?? 'could not book that noisy neighbour');
    };
    if ('pair' in req) {
      this.api.createNoisyPair(req.pair).subscribe({
        next: (res) => done(res.noisy),
        error: failed,
      });
    } else {
      this.api.createNoisy(req.one).subscribe({ next: (row) => done([row]), error: failed });
    }
  }

  protected remove(name: string): void {
    this.deleteError.set('');
    this.deleting.update((list) => [...list, name]);
    this.api.deleteNoisy(name).subscribe({
      next: () => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.fresh.update((list) => list.filter((n) => n.name !== name && n.sink !== name));
      },
      error: (err: { error?: { error?: string } }) => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.deleteError.set(err.error?.error ?? `could not release ${name}`);
      },
    });
  }
}
