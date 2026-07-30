import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  signal,
  viewChild,
} from '@angular/core';

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

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        this.flash();
        return;
      } catch {
        // Denied or unavailable — fall through to the legacy path.
      }
    }
    // execCommand still works where the async clipboard API is refused, which
    // is any non-secure context — a port-forward to http://localhost:8080, for
    // instance, or the demo served over plain HTTP.
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      this.flash();
    } catch {
      // Nothing else to try; leave the button unchanged.
    }
    document.body.removeChild(ta);
  }

  private flash(): void {
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 1000);
  }
}
