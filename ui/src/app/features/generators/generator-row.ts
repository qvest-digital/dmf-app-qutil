import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { Generator, GeneratorsResponse, ReaderRequest } from '../../core/api/models';
import { generatorState } from './generator-state';
import { ReaderRow } from './reader-row';
import { validateReaders } from './generator-validation';

/** A reader request for the generator it names, as the row hands it up. */
export interface AddReaders {
  generator: string;
  request: ReaderRequest;
}

/**
 * One booked generator, in the same row shape the operator flow list uses: dot,
 * name, what it produces, and the action that releases it.
 */
@Component({
  selector: 'mv-generator-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReaderRow],
  template: `
    <div class="flow">
      <div class="row">
        <span class="dot" [class]="state().cls" [title]="tooltip()"></span>
        <span class="name">
          @if (generator().ringUrl; as ring) {
            <a class="ring-link" [href]="ring" target="_blank" rel="noopener noreferrer">{{
              generator().name
            }}</a>
          } @else {
            {{ generator().name }}
          }
          @if (generator().video) {
            <span class="badge video">video</span>
          }
          @if (generator().audio) {
            <span class="badge audio">audio</span>
          }
        </span>
        <span class="quick">
          <span class="m">
            <div class="k">state</div>
            <div class="v">{{ state().label }}</div>
          </span>
          <span class="m">
            <div class="k">produces</div>
            <div class="v lime">{{ produces() }}</div>
          </span>
        </span>
        <span class="actions">
          <button
            class="btn kill"
            type="button"
            [disabled]="busy() || generator().deleting"
            (click)="remove.emit(generator().name)"
          >
            {{ busy() ? 'Deleting...' : 'Delete' }}
          </button>
        </span>
      </div>
      <div class="of-meta">
        @if (generator().video; as video) {
          {{ video.id }}
        }
        @if (generator().audio; as audio) {
          | {{ audio.id }}
        }
        @if (generator().node; as node) {
          | <span class="loc">on {{ node }}</span>
        }
        @if (expiry()) {
          | <span class="loc">{{ expiry() }}</span>
        }
      </div>
      @for (reader of generator().readers ?? []; track reader.name) {
        <mv-reader-row
          [reader]="reader"
          [busy]="busyReaders().includes(reader.name)"
          (remove)="removeReader.emit($event)"
        />
      }
      @if (adding()) {
        <div class="gen-actions gen-reader-add">
          <input
            class="gen-input gen-count"
            type="number"
            min="1"
            [max]="limits()?.maxCopies ?? 1"
            aria-label="Readers"
            [value]="addCount()"
            (input)="addCount.set(+value($event))"
          />
          <input
            class="gen-input gen-mono"
            type="text"
            aria-label="Reader node"
            placeholder="any node"
            spellcheck="false"
            [value]="addNode()"
            (input)="addNode.set(value($event))"
          />
          <select
            class="gen-select"
            aria-label="Transport"
            [value]="addProvider()"
            (change)="addProvider.set(value($event))"
          >
            @for (p of limits()?.providers ?? ['auto']; track p) {
              <option [value]="p">{{ p }}</option>
            }
          </select>
          <button class="btn" type="button" [disabled]="!!addError()" (click)="submitReaders()">
            Add
          </button>
          <button class="btn" type="button" (click)="adding.set(false)">Cancel</button>
        </div>
        @if (addError(); as text) {
          <div class="gen-errors">{{ text }}</div>
        }
      } @else if (hasFlows()) {
        <div class="gen-actions gen-reader-add">
          <button
            class="btn"
            type="button"
            [disabled]="generator().deleting"
            (click)="adding.set(true)"
          >
            Add readers
          </button>
        </div>
      }
    </div>
  `,
})
export class GeneratorRow {
  readonly generator = input.required<Generator>();
  /** A delete is in flight for this row. */
  readonly busy = input(false);
  readonly remove = output<string>();
  /** What the server accepts, for the reader controls. */
  readonly limits = input<GeneratorsResponse | null>(null);
  /** Readers with a delete in flight. */
  readonly busyReaders = input<string[]>([]);
  readonly addReaders = output<AddReaders>();
  readonly removeReader = output<string>();

  protected readonly adding = signal(false);
  protected readonly addCount = signal(1);
  protected readonly addNode = signal('');
  protected readonly addProvider = signal('auto');

  private readonly readerRequest = computed<ReaderRequest>(() => ({
    count: this.addCount(),
    node: this.addNode().trim(),
    provider: this.addProvider(),
  }));

  protected readonly addError = computed(() =>
    validateReaders(this.readerRequest(), this.limits()),
  );

  protected readonly hasFlows = computed(
    () => !!(this.generator().video || this.generator().audio),
  );

  protected value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected submitReaders(): void {
    this.addReaders.emit({ generator: this.generator().name, request: this.readerRequest() });
    this.adding.set(false);
  }

  protected readonly state = computed(() => generatorState(this.generator()));

  protected readonly tooltip = computed(() => {
    const reachable = this.generator().reachable;
    const phase = this.generator().phase ?? 'no phase yet';
    return reachable?.message ? `${phase}: ${reachable.message}` : phase;
  });

  /** The pattern and geometry for video, the width and rate for audio. */
  protected readonly produces = computed(() => {
    const generator = this.generator();
    const parts: string[] = [];
    if (generator.video) {
      const video = generator.video;
      parts.push(
        [video.pattern, `${video.frameWidth}x${video.frameHeight}`, video.grainRate]
          .filter(Boolean)
          .join(' - '),
      );
    }
    if (generator.audio) {
      const audio = generator.audio;
      parts.push(`${audio.channelCount} ch @ ${audio.sampleRate}`);
    }
    return parts.join('  |  ') || '--';
  });

  /** Only booked generators expire, and only when the operator asked for one. */
  protected readonly expiry = computed(() => {
    const at = this.generator().expiresAt;
    return at ? `expires ${at.replace('T', ' ').replace('Z', ' UTC')}` : '';
  });
}
