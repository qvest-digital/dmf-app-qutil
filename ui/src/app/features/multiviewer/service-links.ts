import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { BookedService } from '../../core/api/models';

/**
 * Booked functions and where to reach them.
 *
 * Only externalUrl is a link. url is the in-cluster Service address, which a
 * browser cannot resolve, so offering it as one would hand the reader a dead
 * link and say nothing about why.
 */
@Component({
  selector: 'mv-service-links',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="svcgrid">
      @for (svc of services(); track svc.claim) {
        @for (ep of svc.endpoints; track ep.name) {
          <div class="svc">
            <div class="node">{{ svc.claim }} · {{ ep.name }}</div>
            @if (ep.externalUrl) {
              <a class="ext" [href]="ep.externalUrl" target="_blank" rel="noopener">
                {{ ep.externalUrl }}
              </a>
            } @else {
              <span class="name">{{ ep.url }}</span>
              <div class="note">in-cluster only</div>
            }
          </div>
        }
      } @empty {
        <div class="svc">no booked services</div>
      }
    </div>
  `,
})
export class ServiceLinks {
  readonly services = input<BookedService[]>([]);
}
