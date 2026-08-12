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
import { Generator, GeneratorRequest, GeneratorsResponse } from '../../core/api/models';
import { validateGenerator } from './generator-validation';

/**
 * The booking form: a pattern, a geometry, optional audio, and a flow id per
 * output.
 *
 * Signals and plain bindings rather than @angular/forms, which this app has never
 * used. Every choice that is not free text is a select over what /api/generators
 * says the server accepts, so the form cannot offer a value the aggregator would
 * refuse -- and the ids are minted by the server, because uniqueness can only be
 * judged against the cluster's index.
 */
@Component({
  selector: 'mv-generator-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="gwbar">
      <h2>Book a generator</h2>

      <div class="gen-field">
        <label class="gen-label" for="gen-label">Label</label>
        <input
          id="gen-label"
          class="gen-input"
          type="text"
          [value]="label()"
          (input)="label.set(value($event))"
          placeholder="Bars 1"
        />
        <div class="gen-hint">Names the claim and the NMOS group hint.</div>
      </div>

      <div class="gen-field">
        <label class="gen-check">
          <input type="checkbox" [checked]="videoOn()" (change)="videoOn.set(checked($event))" />
          Video
        </label>
      </div>

      @if (videoOn()) {
        <div class="gen-field">
          <label class="gen-label" for="gen-pattern">Pattern</label>
          <select
            id="gen-pattern"
            class="gen-select"
            [value]="pattern()"
            (change)="pattern.set(value($event))"
          >
            @for (p of limits()?.patterns ?? []; track p) {
              <option [value]="p">{{ p }}{{ animated(p) ? ' (animated)' : '' }}</option>
            }
          </select>
          @if (animated(pattern())) {
            <div class="gen-hint">
              Animated: every frame is regenerated, so it costs several times a still pattern and
              may not hold its rate at the larger frame sizes.
            </div>
          }
        </div>

        <div class="gen-field">
          <label class="gen-label" for="gen-size">Frame size</label>
          <select
            id="gen-size"
            class="gen-select"
            [value]="frameSize()"
            (change)="frameSize.set(value($event))"
          >
            @for (size of limits()?.frameSizes ?? []; track size.width) {
              <option [value]="size.width + 'x' + size.height">
                {{ size.width }}x{{ size.height }}
              </option>
            }
          </select>
        </div>

        <div class="gen-field">
          <label class="gen-label" for="gen-rate">Grain rate</label>
          <select
            id="gen-rate"
            class="gen-select"
            [value]="grainRate()"
            (change)="grainRate.set(value($event))"
          >
            @for (rate of limits()?.grainRates ?? []; track rate.numerator) {
              <option [value]="rate.numerator + '/' + rate.denominator">
                {{ rate.numerator }}/{{ rate.denominator }}
              </option>
            }
          </select>
        </div>

        <div class="gen-field">
          <label class="gen-label" for="gen-overlay">Overlay text</label>
          <input
            id="gen-overlay"
            class="gen-input"
            type="text"
            [value]="overlayText()"
            (input)="overlayText.set(value($event))"
            placeholder="none"
          />
        </div>

        <div class="gen-field">
          <label class="gen-label" for="gen-video-id">Video flow id</label>
          <div class="gen-actions">
            <input
              id="gen-video-id"
              class="gen-input gen-mono"
              type="text"
              [value]="videoId()"
              (input)="videoId.set(value($event))"
              spellcheck="false"
            />
            <button class="btn" type="button" [disabled]="rolling()" (click)="reroll()">
              Generate
            </button>
          </div>
        </div>
      }

      <div class="gen-field">
        <label class="gen-check">
          <input type="checkbox" [checked]="audioOn()" (change)="audioOn.set(checked($event))" />
          Audio
        </label>
      </div>

      @if (audioOn()) {
        <div class="gen-field">
          <label class="gen-label" for="gen-sample-rate">Sample rate</label>
          <select
            id="gen-sample-rate"
            class="gen-select"
            [value]="sampleRate()"
            (change)="sampleRate.set(+value($event))"
          >
            @for (rate of limits()?.sampleRates ?? []; track rate) {
              <option [value]="rate">{{ rate }}</option>
            }
          </select>
        </div>

        <div class="gen-field">
          <label class="gen-label" for="gen-channels">Channels</label>
          <input
            id="gen-channels"
            class="gen-input"
            type="number"
            min="1"
            max="16"
            [value]="channelCount()"
            (input)="channelCount.set(+value($event))"
          />
          <div class="gen-hint">One tone per channel, a sine at (channel + 1) x 100 Hz.</div>
        </div>

        <div class="gen-field">
          <label class="gen-label" for="gen-audio-id">Audio flow id</label>
          <input
            id="gen-audio-id"
            class="gen-input gen-mono"
            type="text"
            [value]="audioId()"
            (input)="audioId.set(value($event))"
            spellcheck="false"
          />
        </div>
      }

      <div class="gen-field">
        <label class="gen-label" for="gen-ttl">Expires</label>
        <select id="gen-ttl" class="gen-select" [value]="ttl()" (change)="ttl.set(value($event))">
          @for (choice of limits()?.ttls ?? []; track choice) {
            <option [value]="choice">{{ choice === 'none' ? 'never' : 'in ' + choice }}</option>
          }
        </select>
        <div class="gen-hint">
          Nothing else prunes a booking made here: neither Helm nor Flux knows about it.
        </div>
      </div>

      @if (error(); as text) {
        <div class="gen-errors" aria-live="polite">{{ text }}</div>
      }

      <div class="gen-actions">
        <button class="btn" type="button" [disabled]="!submittable()" (click)="submit()">
          {{ busy() ? 'Booking…' : 'Book generator' }}
        </button>
        @if (full()) {
          <span class="gen-hint">At the limit of {{ limits()?.max }}; delete one first.</span>
        }
      </div>
    </div>
  `,
})
export class GeneratorForm {
  /** What the server accepts, straight from the page's poll. */
  readonly limits = input<GeneratorsResponse | null>(null);
  readonly full = input(false);
  readonly created = output<Generator>();

  private readonly api = inject(MetricsApi);

  protected readonly label = signal('');
  protected readonly pattern = signal('smpte');
  protected readonly overlayText = signal('');
  protected readonly frameSize = signal('1296x720');
  protected readonly grainRate = signal('30000/1001');
  protected readonly videoOn = signal(true);
  protected readonly audioOn = signal(false);
  protected readonly sampleRate = signal(48000);
  protected readonly channelCount = signal(2);
  protected readonly videoId = signal('');
  protected readonly audioId = signal('');
  protected readonly ttl = signal('1h');
  protected readonly busy = signal(false);
  protected readonly rolling = signal(false);
  /** What the server said, which outranks anything this form worked out itself. */
  protected readonly serverError = signal('');

  constructor() {
    this.reroll();
    // A server's complaint is about the values that were sent. Editing any of
    // them makes it stale, and a stale error beside a changed field reads as a
    // rule the form is enforcing.
    effect(() => {
      this.request();
      untracked(() => this.serverError.set(''));
    });
  }

  protected readonly request = computed<GeneratorRequest>(() => {
    const [width, height] = this.frameSize().split('x');
    const [numerator, denominator] = this.grainRate().split('/');
    return {
      label: this.label(),
      ttl: this.ttl(),
      video: {
        enabled: this.videoOn(),
        id: this.videoId().trim(),
        pattern: this.pattern(),
        overlayText: this.overlayText(),
        frameWidth: +width,
        frameHeight: +height,
        grainRate: { numerator: +numerator, denominator: +denominator },
      },
      audio: {
        enabled: this.audioOn(),
        id: this.audioId().trim(),
        sampleRate: this.sampleRate(),
        channelCount: this.channelCount(),
      },
    };
  });

  protected readonly error = computed(
    () => this.serverError() || validateGenerator(this.request(), this.limits()),
  );

  protected readonly submittable = computed(
    () => !this.busy() && !this.full() && !validateGenerator(this.request(), this.limits()),
  );

  protected animated(pattern: string): boolean {
    return (this.limits()?.animated ?? []).includes(pattern);
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  protected reroll(): void {
    this.rolling.set(true);
    this.api.newFlowIds().subscribe({
      next: (ids) => {
        this.rolling.set(false);
        this.videoId.set(ids.videoFlowId);
        this.audioId.set(ids.audioFlowId);
      },
      // Booking is disabled, or the uniqueness index is unreadable. Either way the
      // fields stay as they are and the server refuses a submission anyway.
      error: (err: { error?: { error?: string } }) => {
        this.rolling.set(false);
        this.serverError.set(err.error?.error ?? '');
      },
    });
  }

  protected submit(): void {
    this.busy.set(true);
    this.serverError.set('');
    this.api.createGenerator(this.request()).subscribe({
      next: (generator) => {
        this.busy.set(false);
        this.created.emit(generator);
        // Fresh ids and a clear label, so the next booking cannot reuse either.
        this.label.set('');
        this.overlayText.set('');
        this.reroll();
      },
      error: (err: { error?: { error?: string } }) => {
        this.busy.set(false);
        this.serverError.set(err.error?.error ?? 'booking failed');
      },
    });
  }
}
