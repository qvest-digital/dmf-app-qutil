import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MxlGraph } from '../../core/api/models';
import { PLAIN } from './flow-fixtures';
import { FlowsPage } from './flows-page';

describe('FlowsPage', () => {
  let fixture: ComponentFixture<FlowsPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    fixture = TestBed.createComponent(FlowsPage);
    http = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    http.match(() => true).forEach((r) => r.cancelled || r.flush({}));
  });

  /** The poll's first tick is a timer, so the request goes out a turn later. */
  async function answer(graph: MxlGraph): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.expectOne('/api/mxl-graph').flush(graph);
    fixture.detectChanges();
  }

  it('says it is reading until the first answer lands', () => {
    expect(el().textContent).toContain('Reading the cluster.');
    expect(el().querySelector('mv-flow-diagram')).toBeNull();
  });

  it('draws the graph the aggregator answers', async () => {
    await answer(PLAIN);
    expect(el().querySelector('mv-flow-diagram svg')).not.toBeNull();
    expect(el().querySelectorAll('mv-flow-diagram .card').length).toBe(4);
  });

  it('says so when no flow exists rather than drawing an empty frame', async () => {
    await answer({ flows: [], nodes: [], sets: [] });
    expect(el().textContent).toContain('No MXL flow exists right now.');
    expect(el().querySelector('mv-flow-diagram')).toBeNull();
  });

  /** The graph is drawn without a list it could not read, so a missing
   *  reader or node is only explained by naming that list beside it. */
  it('names every list the graph could not read', async () => {
    await answer({ ...PLAIN, degraded: { '/api/v1/pods': 'HTTP Error 403: Forbidden' } });
    const errors = [...el().querySelectorAll('.gen-errors')].map((e) => e.textContent!.trim());
    expect(errors).toEqual(['Not read: /api/v1/pods: HTTP Error 403: Forbidden']);
    expect(el().querySelector('mv-flow-diagram svg')).not.toBeNull();
  });
});
