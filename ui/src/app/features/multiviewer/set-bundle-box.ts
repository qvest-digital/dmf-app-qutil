import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { FlowCondition, RedundancySet } from '../../core/api/models';
import { PreviewController, requestFor } from '../preview/preview-controller';
import { FlowGroupHead } from './flow-group-head';
import { OperatorFlowRow } from './operator-flow-row';
import { SetBundle } from './set-bundles';

/**
 * A condition's status, or null where it is missing or was written for an
 * older generation of the set: then it says nothing about the spec now.
 */
export function currentStatus(
  set: RedundancySet,
  c: FlowCondition | null | undefined,
): string | null {
  if (!c?.status) return null;
  const seen = c.observedGeneration ?? set.observedGeneration;
  if (set.generation != null && seen != null && seen < set.generation) return null;
  return c.status;
}

/** The set's dot: green while it merges every member, orange once the
 *  operator says it cannot, grey while it has said nothing current. */
export function setState(set: RedundancySet): 'live' | 'bad' | '' {
  const valid = currentStatus(set, set.valid);
  const ready = currentStatus(set, set.membersReady);
  if (valid === 'False' || ready === 'False') return 'bad';
  if (valid === 'True' && ready === 'True') return 'live';
  return '';
}

function conditionText(status: string | null, yes: string, no: string): string {
  if (!status) return `${yes}?`;
  return status === 'True' ? yes : no;
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
            {{ conditions(view.set) }} | {{ view.set.preference || 'Ordered' }}
            @if (view.set.nodes?.length) {
              | wanted on {{ view.set.nodes!.join(', ') }}
            }
          </span>
          @for (text of warnings(view.set); track $index) {
            <span class="rs-warn">{{ text }}</span>
          }
        </div>
        <mv-operator-flow-row [flow]="view.output" role="output" />
        @for (member of view.members; track $index; let i = $index) {
          @if (member.flow) {
            <mv-operator-flow-row [flow]="member.flow" [role]="'member ' + (i + 1)" />
          } @else {
            <div class="flow rs-missing">
              <span class="badge role">member {{ i + 1 }}</span>
              <span class="of-meta">{{ member.id }} | no MxlFlow: nothing produces it</span>
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
      conditionText(currentStatus(set, set.valid), 'valid', 'invalid'),
      conditionText(currentStatus(set, set.membersReady), 'members ready', 'members missing'),
    ].join(' | ');
  }

  /** The operator's own words for what is wrong, from current conditions only. */
  protected warnings(set: RedundancySet): string[] {
    return [set.membersReady, set.valid]
      .filter((c) => currentStatus(set, c) === 'False' && c?.message)
      .map((c) => c!.message!);
  }

  protected tooltip(set: RedundancySet): string {
    return [set.valid, set.membersReady]
      .filter((c): c is FlowCondition => !!c)
      .map(
        (c) =>
          `${c.type} ${currentStatus(set, c) ?? 'unknown'}: ${c.reason ?? ''}` +
          (currentStatus(set, c) === null && c.status ? ' (written for an older spec)' : ''),
      )
      .join(' | ');
  }

  /** One path carrying both merged outputs, as a group head opens a pair. */
  protected preview(): void {
    const pair = this.pair();
    if (!pair) return;
    this.preview$.open(requestFor(pair.video, pair.audio));
  }
}
