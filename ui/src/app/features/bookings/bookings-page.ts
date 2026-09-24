import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { Booking } from '../../core/api/models';
import { classError, parseParams } from './booking-params';

/**
 * Booking any class the catalog carries: the form on the left, what it booked on
 * the right.
 *
 * The Generators page books one class through a form that knows its parameters.
 * This one knows nothing about the class it is given, so the parameters are
 * typed as YAML and sent as the claim's spec.parameters verbatim. Nothing
 * downstream validates them either -- no class publishes a schema -- so a
 * mistyped key reaches the provisioner as typed and shows up as a claim that
 * never binds.
 *
 * Only the claims this page created are listed, by label selector, so the
 * chart's claims and the Generators page's are both out of reach of the delete
 * button.
 */
@Component({
  selector: 'mv-bookings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  templateUrl: './bookings-page.html',
})
export class BookingsPage {
  private readonly api = inject(MetricsApi);

  /** Same cadence as the generators list: a claim's phase moves in seconds. */
  private readonly data = poll(3000, () => this.api.bookings());

  protected readonly enabled = computed(() => this.data()?.enabled !== false);
  protected readonly namespace = computed(() => this.data()?.namespace ?? '');
  protected readonly listError = computed(() => this.data()?.error ?? '');

  protected readonly className = signal('');
  protected readonly label = signal('');
  protected readonly params = signal('');
  protected readonly submitting = signal(false);
  protected readonly formError = signal('');
  protected readonly deleteError = signal('');

  private readonly fresh = signal<Booking[]>([]);
  private readonly deleting = signal<string[]>([]);

  /** Booked claims, with anything created since the last poll in front: a create
   *  returns its claim, and waiting up to 3s would read as the button having
   *  done nothing. */
  protected readonly bookings = computed(() => {
    const polled = this.data()?.bookings ?? [];
    const names = new Set(polled.map((b) => b.name));
    return [...this.fresh().filter((b) => !names.has(b.name)), ...polled];
  });

  protected readonly full = computed(() => {
    const max = this.data()?.max ?? 0;
    return max > 0 && this.bookings().length >= max;
  });

  protected isDeleting(name: string): boolean {
    return this.deleting().includes(name);
  }

  protected book(): void {
    this.formError.set('');

    const bad = classError(this.className());
    if (bad) return this.formError.set(bad);

    const { value, error } = parseParams(this.params());
    if (error) return this.formError.set(`parameters: ${error}`);
    if (!value) return this.formError.set('parameters must be a mapping of keys to values');

    this.submitting.set(true);
    this.api
      .createBooking({
        className: this.className().trim(),
        label: this.label().trim(),
        parameters: value,
      })
      .subscribe({
        next: (booking) => {
          this.submitting.set(false);
          this.fresh.update((list) => [booking, ...list]);
          // The class stays: booking several of one class is the common case.
          this.label.set('');
        },
        error: (err: { error?: { error?: string } }) => {
          this.submitting.set(false);
          this.formError.set(err.error?.error ?? 'could not book that function');
        },
      });
  }

  protected remove(name: string): void {
    this.deleteError.set('');
    this.deleting.update((list) => [...list, name]);
    this.api.deleteBooking(name).subscribe({
      next: () => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.fresh.update((list) => list.filter((b) => b.name !== name));
      },
      error: (err: { error?: { error?: string } }) => {
        this.deleting.update((list) => list.filter((n) => n !== name));
        this.deleteError.set(err.error?.error ?? `could not delete ${name}`);
      },
    });
  }
}
