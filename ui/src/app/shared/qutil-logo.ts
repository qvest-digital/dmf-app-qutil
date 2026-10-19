import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * The Qutil product mark: a Q whose counter carries a signal pulse. Inline for
 * the same reason the Qvest wordmark is, so the header paints without a
 * network round-trip.
 *
 * The wordmark is text rather than paths so it renders in the page's own face
 * and stays legible at any size, which drawn letterforms at this scale do not.
 */
@Component({
  selector: 'mv-qutil-logo',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span class="qutil-logo">
    <svg viewBox="0 0 160 160" role="img" aria-label="Qutil" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="78" cy="74" r="52" stroke="var(--qv-orange)" stroke-width="13" />
        <!-- Ink rather than a tint of the ring: the header is white, so a pale
             pulse disappears into it, and the ring's own colour closes the
             counter up at header size. Kept inside the ring, because a wave
             that crosses it turns the mark into a magnifying glass. -->
        <path
          d="M44 74 L58 74 L68 48 L80 102 L92 56 L102 74 L114 74"
          stroke="var(--qv-ink)"
          stroke-width="9"
        />
        <!-- Starts inside the ring and stops just past it. A tail that runs
             further reads as a handle rather than as a Q. -->
        <path d="M104 100 L132 128" stroke="var(--qv-orange)" stroke-width="13" />
      </g>
    </svg>
    <b>QUTIL</b>
  </span>`,
})
export class QutilLogo {}
