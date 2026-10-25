import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FlowCondition, RedundancySet } from '../../core/api/models';
import { PreviewController, requestFor } from '../preview/preview-controller';
import { FlowGroupHead } from './flow-group-head';
import { OperatorFlowRow } from './operator-flow-row';
import { SetBundle } from './set-bundles';

/** The set's dot: green while it merges every member, orange once the
 *  operator says it cannot, grey while it has said nothing. */
export function setState(set: RedundancySet): 'live' | 'bad' | '' {
  const valid = set.valid?.status;
  const ready = set.membersReady?.status;
  if (valid === 'False' || ready === 'False') return 'bad';
  if (valid === 'True' && ready === 'True') return 'live';
  return '';
}

function conditionText(c: FlowCondition | null | undefined, yes: string, no: string): string {
  if (!c?.status) return `${yes}?`;
  return c.status === 'True' ? yes : no;
}

/**
 * One box for the redundancy sets whose members share NMOS groups: per set its
 * state, its output and its members in order of preference, then the members'
 * own groups, each with the picture-and-sound preview a group head offers.
 *
 * The outputs get a combined preview of their own. A merged picture and a
 * merged sound are one programme, and nothing else in the list pairs them: an
 * output carries no group hint.
 */
@Component({
  selector: 'mv-set-bundle-box',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlowGroupHead, OperatorFlowRow],
  template: `
    <div class="flow-group rs-bundle">
      <div class="fg-head">
        <span class="fg-name" title="Redundancy sets">{{ title() }}</span>
        @if (pair()) {
          <button class="btn fg-prev" type="button" [title]="pairTitle()" (click)="preview()">
            Preview A/V
          </button>
        }
      </div>
      @for (view of bundle().sets; track view.set.name) {
        <div class="rs-head">
          <span class="dot" [class]="state(view.set)" [title]="tooltip(view.set)"></span>
          <span class="rs-name">{{ view.set.name }}</span>
          <span class="rs-meta">
            {{ conditions(view.set) }} · {{ view.set.preference || 'Ordered' }}
            @if (view.set.nodes?.length) {
              · merged on {{ view.set.nodes!.join(', ') }}
            }
          </span>
          @if (view.set.membersReady?.status === 'False' && view.set.membersReady?.message) {
            <span class="rs-warn">{{ view.set.membersReady!.message }}</span>
          }
          @if (view.set.valid?.status === 'False' && view.set.valid?.message) {
            <span class="rs-warn">{{ view.set.valid!.message }}</span>
          }
        </div>
        <mv-operator-flow-row [flow]="view.set.output" role="output" />
        @for (member of view.members; track member.id; let i = $index) {
          @if (member.flow) {
            <mv-operator-flow-row [flow]="member.flow" [role]="'member ' + (i + 1)" />
          } @else {
            <div class="flow rs-missing">
              <span class="badge role">member {{ i + 1 }}</span>
              <span class="of-meta">{{ member.id }} · no MxlFlow: nothing produces it</span>
            </div>
          }
        }
      }
      @for (group of bundle().groups; track group.name) {
        <mv-flow-group-head [group]="group" />
      }
      @for (flow of bundle().others; track flow.id) {
        <mv-operator-flow-row [flow]="flow" />
      }
    </div>
  `,
})
export class SetBundleBox {
  readonly bundle = input.required<SetBundle>();

  private readonly preview$ = inject(PreviewController);

  protected readonly title = computed(() => this.bundle().outputs.name);

  protected readonly pair = computed(() => {
    const { video, audio } = this.bundle().outputs;
    return video && audio ? { video, audio } : null;
  });

  protected readonly pairTitle = computed(() => {
    const pair = this.pair();
    return pair ? `${pair.video.label} with ${pair.audio.label}` : '';
  });

  protected state(set: RedundancySet): string {
    return setState(set);
  }

  protected conditions(set: RedundancySet): string {
    return [
      conditionText(set.valid, 'valid', 'invalid'),
      conditionText(set.membersReady, 'members ready', 'members missing'),
    ].join(' · ');
  }

  protected tooltip(set: RedundancySet): string {
    return [set.valid, set.membersReady]
      .filter((c): c is FlowCondition => !!c)
      .map((c) => `${c.type} ${c.status}: ${c.reason ?? ''}`)
      .join(' · ');
  }

  /** One path carrying both merged outputs, as a group head opens a pair. */
  protected preview(): void {
    const pair = this.pair();
    if (!pair) return;
    this.preview$.open(requestFor(pair.video, pair.audio));
  }
}
