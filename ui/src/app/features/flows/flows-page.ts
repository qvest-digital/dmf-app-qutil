import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { MetricsApi } from '../../core/api/metrics-api';
import { poll } from '../../core/api/poll';
import { FlowDiagram } from './flow-diagram';

/** A booking creates flows within seconds; the paths move only when one does. */
const REFRESH_MS = 5000;

/**
 * Every MXL flow drawn from its writer to its readers, inside the node each
 * runs on. A read that stays in its node is served out of shared memory; one
 * that leaves it waits on a mirror the gateway carries across the fabric.
 */
@Component({
  selector: 'mv-flows-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlowDiagram],
  template: `<main class="flows-main">
    <section class="panel">
      <h2>Flow paths</h2>
      <p class="flows-lead">
        A flow lives in the shared memory of the node that writes it. A reader on that node opens it
        there and nothing crosses the fabric; a reader anywhere else is served from a copy the
        gateway mirrors for it.
      </p>
      @for (read of degraded(); track read.path) {
        <div class="gen-errors">Not read: {{ read.path }}: {{ read.error }}</div>
      }
      @if (graph(); as g) {
        @if (g.flows.length || g.sets?.length) {
          <mv-flow-diagram [graph]="g" />
        } @else {
          <p class="flows-lead">No MXL flow exists right now.</p>
        }
      } @else {
        <p class="flows-lead">Reading the cluster.</p>
      }
    </section>
  </main>`,
})
export class FlowsPage {
  private readonly api = inject(MetricsApi);
  protected readonly graph = poll(REFRESH_MS, () => this.api.mxlGraph());

  /** The lists the graph could not read. It is drawn without them, so what it
   *  leaves out has to be said beside it. */
  protected readonly degraded = computed(() =>
    Object.entries(this.graph()?.degraded ?? {}).map(([path, error]) => ({ path, error })),
  );
}
