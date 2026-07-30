import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { Flow } from '../../core/api/models';
import { FmtPipe } from '../../shared/format-pipes';
import { FlowDetail } from './flow-detail';

/** How long the Kill button stays in its result state before resetting. */
const KILL_RESET_MS = 4000;

/**
 * One of the four demo flows in the side panel: live dot, headline numbers, an
 * expandable detail panel, and the button that deletes its writer pod so the
 * audience can watch Kubernetes put it back.
 */
@Component({
  selector: 'mv-flow-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlowDetail, FmtPipe],
  template: `
    <div class="flow">
      <div class="row">
        <span class="dot" [class.live]="live()" [class.bad]="!live()"></span>
        <span class="name">
          {{ flow().label }}<span class="pat">{{ flow().writer?.pattern }}</span>
        </span>
        <span class="quick">
          <span class="m">
            <div class="k">grains/s</div>
            <div class="v">{{ compositor().fps | fmt: 1 }}</div>
          </span>
          <span class="m">
            <div class="k">Mbit/s</div>
            <div class="v lime">{{ compositor().mbps | fmt }}</div>
          </span>
        </span>
        <span class="actions">
          <button class="btn" type="button" (click)="open.set(!open())">
            Details {{ open() ? '▴' : '▾' }}
          </button>
          <button class="btn kill" type="button" [disabled]="killing()" (click)="kill()">
            {{ killLabel() }}
          </button>
        </span>
      </div>
      <div class="detail" [class.open]="open()">
        @if (open()) {
          <mv-flow-detail [flow]="flow()" />
        }
      </div>
    </div>
  `,
})
export class FlowCard {
  readonly flow = input.required<Flow>();

  private readonly api = inject(MetricsApi);

  protected readonly open = signal(false);
  protected readonly killing = signal(false);
  protected readonly killLabel = signal('Kill');

  protected readonly compositor = computed(() => this.flow().compositor ?? {});
  protected readonly live = computed(() => !!this.compositor().live);

  protected kill(): void {
    this.killing.set(true);
    this.killLabel.set('Killing…');
    this.api.kill(this.flow().n).subscribe({
      next: () => this.settle('Killed'),
      error: () => this.settle('Kill failed'),
    });
  }

  private settle(label: string): void {
    this.killLabel.set(label);
    setTimeout(() => {
      this.killing.set(false);
      this.killLabel.set('Kill');
    }, KILL_RESET_MS);
  }
}
