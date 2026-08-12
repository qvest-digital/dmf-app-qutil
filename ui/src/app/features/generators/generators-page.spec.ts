import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Generator, GeneratorsResponse } from '../../core/api/models';
import { GeneratorsPage } from './generators-page';

function generator(over: Partial<Generator> = {}): Generator {
  return {
    name: 'generator-bars-1-7f3a',
    namespace: 'production-demo-app',
    className: 'mxl-writer',
    phase: 'Bound',
    ready: true,
    video: {
      id: '3f2c8a1e-1111-4222-8333-444455556666',
      pattern: 'smpte',
      frameWidth: 1296,
      frameHeight: 720,
      grainRate: '30000/1001',
    },
    audio: null,
    ...over,
  };
}

function response(over: Partial<GeneratorsResponse> = {}): GeneratorsResponse {
  return {
    namespace: 'production-demo-app',
    className: 'mxl-writer',
    enabled: true,
    max: 8,
    ttls: ['1h', 'none'],
    patterns: ['smpte'],
    animated: [],
    frameSizes: [{ width: 1296, height: 720 }],
    grainRates: [{ numerator: 30000, denominator: 1001 }],
    sampleRates: [48000],
    generators: [],
    ...over,
  };
}

/**
 * The page lists only what it booked -- the aggregator selects by its own label,
 * so the chart's writer claims are never here and cannot be deleted from here.
 */
describe('GeneratorsPage', () => {
  let fixture: ComponentFixture<GeneratorsPage>;
  let http: HttpTestingController;

  function rows(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.flow:not(.empty)'));
  }

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function load(body: GeneratorsResponse): Promise<void> {
    TestBed.configureTestingModule({
      imports: [GeneratorsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GeneratorsPage);
    fixture.detectChanges();
    // Both polls start on a timer(0), so the first request is a macrotask away.
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.match((req) => req.url === '/api/generators').forEach((req) => req.flush(body));
    // The form asks for ids as soon as it mounts.
    http
      .match((req) => req.url === '/api/generators/flow-ids')
      .forEach((req) =>
        req.flush({ videoFlowId: 'aaaaaaaa-1111-4222-8333-444455556666', audioFlowId: 'b' }),
      );
    fixture.detectChanges();
  }

  afterEach(() => {
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  it('says so when nothing is booked, and why the demo writers are absent', async () => {
    await load(response());
    expect(rows()).toHaveLength(0);
    expect(text()).toContain('The four demo writers come from the chart');
  });

  it('shows a booked generator with what it produces', async () => {
    await load(response({ generators: [generator()] }));

    expect(rows()).toHaveLength(1);
    expect(text()).toContain('generator-bars-1-7f3a');
    expect(text()).toContain('smpte');
    expect(text()).toContain('1296x720');
    expect(text()).toContain('3f2c8a1e-1111-4222-8333-444455556666');
    expect(fixture.nativeElement.querySelector('.dot.live')).toBeTruthy();
  });

  it('reports why a claim has not gone ready rather than calling it pending', async () => {
    await load(
      response({
        generators: [
          generator({
            phase: 'Pending',
            ready: false,
            reachable: { type: 'Reachable', status: 'False', reason: 'WaitingForProvisioner' },
          }),
        ],
      }),
    );
    expect(text()).toContain('WaitingForProvisioner');
    expect(fixture.nativeElement.querySelector('.dot.live')).toBeNull();
  });

  it('marks a failed claim bad', async () => {
    await load(
      response({
        generators: [
          generator({
            phase: 'Failed',
            ready: false,
            reachable: { type: 'Reachable', status: 'False', reason: 'ProvisionFailed' },
          }),
        ],
      }),
    );
    expect(fixture.nativeElement.querySelector('.dot.bad')).toBeTruthy();
  });

  it('deletes the generator whose button was pressed', async () => {
    await load(response({ generators: [generator()] }));
    (rows()[0].querySelector('.btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();

    const req = http.expectOne(
      (r) => r.method === 'DELETE' && r.url === '/api/generators/generator-bars-1-7f3a',
    );
    req.flush({ deleted: 'generator-bars-1-7f3a' });
  });

  it('surfaces a refused delete', async () => {
    await load(response({ generators: [generator()] }));
    (rows()[0].querySelector('.btn.kill') as HTMLButtonElement).click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.method === 'DELETE')
      .flush(
        { error: 'generator-bars-1-7f3a was not booked from this page' },
        { status: 403, statusText: 'Forbidden' },
      );
    fixture.detectChanges();

    expect(text()).toContain('was not booked from this page');
  });

  it('cannot delete a claim already on its way out', async () => {
    await load(response({ generators: [generator({ deleting: true })] }));
    expect(text()).toContain('deleting');
    expect((rows()[0].querySelector('.btn.kill') as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers no form where booking is switched off', async () => {
    await load(response({ enabled: false }));
    expect(fixture.nativeElement.querySelector('#gen-label')).toBeNull();
    expect(text()).toContain('Booking is switched off on this install');
  });
});
