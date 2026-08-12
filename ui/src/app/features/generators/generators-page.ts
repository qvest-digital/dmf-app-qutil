import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { Generator } from '../../core/api/models';
import { GeneratorForm } from './generator-form';
import { GeneratorRow } from './generator-row';

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
  imports: [GeneratorForm, GeneratorRow],
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
    return [...this.fresh().filter((g) => !names.has(g.name)), ...polled];
  });

  protected readonly count = computed(() =>
    this.generators().length ? `(${this.generators().length})` : '',
  );

  protected readonly full = computed(() => {
    const max = this.data()?.max ?? 0;
    return max > 0 && this.generators().length >= max;
  });

  private readonly fresh = signal<Generator[]>([]);
  private readonly deleting = signal<string[]>([]);
  protected readonly deleteError = signal('');

  protected isDeleting(name: string): boolean {
    return this.deleting().includes(name);
  }

  protected onCreated(generator: Generator): void {
    this.fresh.update((list) => [generator, ...list]);
  }

  protected remove(name: string): void {
    this.deleteError.set('');
    this.deleting.update((list) => [...list, name]);
    this.api.deleteGenerator(name).subscribe({
      next: () => {
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
