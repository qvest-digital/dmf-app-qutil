import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { Generator, GeneratorReader } from '../../core/api/models';
import { GeneratorForm } from './generator-form';
import { AddReaders, GeneratorRow } from './generator-row';
import { ReaderForm } from './reader-form';
import { ReaderRow } from './reader-row';

/**
 * Booking writers on demand: the form on the left, what it booked on the right.
 *
 * The aggregator creates the claims, and only the ones it created are listed --
 * a label selector, so the claims this chart renders are never in reach of the
 * delete button. A booked generator's flows show up in the operator flow list
 * like any other, which is where they get previewed.
 */
@Component({
  selector: 'mv-generators-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [GeneratorForm, GeneratorRow, ReaderForm, ReaderRow],
  templateUrl: './generators-page.html',
})
export class GeneratorsPage {
  private readonly api = inject(MetricsApi);

  /** Same cadence as the operator flow list: a claim's phase moves in seconds. */
  private readonly data = poll(3000, () => this.api.generators());

  protected readonly limits = computed(() => this.data());
  protected readonly enabled = computed(() => this.data()?.enabled !== false);
  protected readonly listError = computed(() => this.data()?.error ?? '');

  /**
   * The booked generators, with anything created since the last poll in front.
   * A create returns its claim, and waiting up to 3s to see it would read as the
   * button having done nothing.
   */
  protected readonly generators = computed(() => {
    const polled = this.data()?.generators ?? [];
    const names = new Set(polled.map((g) => g.name));
    const fresh = this.freshReaders();
    return [...this.fresh().filter((g) => !names.has(g.name)), ...polled].map((g) => {
      const added = fresh[g.name] ?? [];
      if (!added.length) return g;
      const known = new Set((g.readers ?? []).map((r) => r.name));
      return { ...g, readers: [...(g.readers ?? []), ...added.filter((r) => !known.has(r.name))] };
    });
  });

  /** Readers of chosen flows, with anything booked since the last poll in front. */
  protected readonly flowReaders = computed(() => {
    const polled = this.data()?.readers ?? [];
    const names = new Set(polled.map((r) => r.name));
    return [...this.freshFlowReaders().filter((r) => !names.has(r.name)), ...polled];
  });

  private readonly freshFlowReaders = signal<GeneratorReader[]>([]);

  protected onReadersCreated(readers: GeneratorReader[]): void {
    this.freshFlowReaders.update((list) => [...readers, ...list]);
  }

  /** Readers whose generator is gone: listed so they can still be released. */
  protected readonly orphans = computed(() => this.data()?.orphanReaders ?? []);

  protected readonly count = computed(() =>
    this.generators().length ? `(${this.generators().length})` : '',
  );

  private readonly fresh = signal<Generator[]>([]);
  /** Readers booked since the last poll, by generator, for the same reason as fresh. */
  private readonly freshReaders = signal<Record<string, GeneratorReader[]>>({});
  protected readonly deleting = signal<string[]>([]);
  protected readonly deleteError = signal('');
  protected readonly readerError = signal('');

  protected isDeleting(name: string): boolean {
    return this.deleting().includes(name);
  }

  protected onCreated(generators: Generator[]): void {
    this.fresh.update((list) => [...generators, ...list]);
  }

  protected addReaders({ generator, request }: AddReaders): void {
    this.readerError.set('');
    this.api.createReaders(generator, request).subscribe({
      next: (batch) => {
        this.freshReaders.update((all) => ({
          ...all,
          [generator]: [...(all[generator] ?? []), ...batch.readers],
        }));
        this.readerError.set(batch.error ?? '');
      },
      error: (err: { error?: { error?: string } }) => {
        this.readerError.set(err.error?.error ?? `could not add readers to ${generator}`);
      },
    });
  }

  protected removeReader(name: string): void {
    this.readerError.set('');
    this.deleting.update((list) => [...list, name]);
    this.api.deleteReader(name).subscribe({
      next: () => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.freshFlowReaders.update((list) => list.filter((r) => r.name !== name));
        this.freshReaders.update((all) =>
          Object.fromEntries(
            Object.entries(all).map(([g, list]) => [g, list.filter((r) => r.name !== name)]),
          ),
        );
      },
      error: (err: { error?: { error?: string } }) => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.readerError.set(err.error?.error ?? `could not delete ${name}`);
      },
    });
  }

  protected remove(name: string): void {
    this.deleteError.set('');
    this.deleting.update((list) => [...list, name]);
    this.api.deleteGenerator(name).subscribe({
      next: (res) => {
        // The generator went, but some of its readers may not have.
        this.deleteError.set((res as { error?: string | null })?.error ?? '');
        this.deleting.update((list) => list.filter((n) => n !== name));
        // Drop it from the optimistic list too, or a deleted generator would sit
        // there until the poll disagreed.
        this.fresh.update((list) => list.filter((g) => g.name !== name));
      },
      error: (err: { error?: { error?: string } }) => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.deleteError.set(err.error?.error ?? `could not delete ${name}`);
      },
    });
  }
}
