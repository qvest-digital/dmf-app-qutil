import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { Generator } from '../../core/api/models';
import { generatorState } from './generator-state';

/**
 * One booked generator, in the same row shape the operator flow list uses: dot,
 * name, what it produces, and the action that releases it.
 */
@Component({
  selector: 'mv-generator-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flow">
      <div class="row">
        <span class="dot" [class]="state().cls" [title]="tooltip()"></span>
        <span class="name">
          {{ generator().name }}
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
            {{ busy() ? 'Deleting…' : 'Delete' }}
          </button>
        </span>
      </div>
      <div class="of-meta">
        @if (generator().video; as video) {
          {{ video.id }}
        }
        @if (generator().audio; as audio) {
          · {{ audio.id }}
        }
        @if (expiry()) {
          · <span class="loc">{{ expiry() }}</span>
        }
      </div>
    </div>
  `,
})
export class GeneratorRow {
  readonly generator = input.required<Generator>();
  /** A delete is in flight for this row. */
  readonly busy = input(false);
  readonly remove = output<string>();

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
          .join(' · '),
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
