import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { copyText } from './clipboard';

/**
 * One row of a `.kv` detail grid: label, value, copy button.
 *
 * The host is display:contents so `.k` and `.v` stay direct children of the
 * two-column `.kv` grid.
 */
@Component({
  selector: 'mv-kv-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="k">{{ label() }}</div>
    <div class="v" [class]="state()" [class.mono]="mono()">
      <span class="vv" #vv><ng-content /></span>
      <button
        class="cp"
        [class.done]="copied()"
        type="button"
        title="Copy"
        aria-label="Copy"
        (click)="copy()"
      >
        {{ copied() ? '✓' : '⧉' }}
      </button>
    </div>
  `,
})
export class KvRow {
  /** Empty for continuation rows, e.g. a condition's message under its type. */
  readonly label = input('');
  readonly state = input<'ok' | 'bad' | 'warn' | ''>('');
  readonly mono = input(false);

  private readonly vv = viewChild.required<ElementRef<HTMLElement>>('vv');
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    const text = (this.vv().nativeElement.textContent ?? '').trim();
    if (!text || text === '--') return;
    if (!(await copyText(text))) return;
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1000);
  }
}
