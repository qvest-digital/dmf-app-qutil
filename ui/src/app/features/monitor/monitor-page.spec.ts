import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MonitorResponse, ReaderFlowStatus } from '../../core/api/models';
import { MonitorPage } from './monitor-page';

const FLOW = 'd4d00000-0000-0000-0000-000000000001';

function status(
  reads: Partial<ReaderFlowStatus['reads']> = {},
  over: Partial<ReaderFlowStatus> = {},
): ReaderFlowStatus {
  return {
    id: FLOW,
    state: 'open',
    delivering: true,
    unit: 'grains',
    mediaType: 'video/v210',
    format: '1920x1080 @ 50/1',
    formatMismatch: '',
    ageSeconds: 0.002,
    reads: {
      ok: 1000,
      too_early: 0,
      too_late: 0,
      invalid: 0,
      incomplete: 0,
      wrong_size: 0,
      wrong_format: 0,
      illegal_values: 0,
      permission_error: 0,
      other_error: 0,
      ...reads,
    },
    openFailures: { domain: 0, not_found: 0, permission: 0, other: 0 },
    skipped: 0,
    stalls: 0,
    opens: 1,
    lost: 0,
    lastError: null,
    ...over,
  };
}

function response(flow: ReaderFlowStatus, mirrorPhase = 'Ready'): MonitorResponse {
  return {
    readers: [
      {
        name: 'generator-bars-r0001',
        generator: 'generator-bars',
        provider: 'tcp',
        pods: [{ name: 'p', node: 'worker-7', phase: 'Running', restarts: 0 }],
        status: { flows: [flow] },
        statusError: null,
      },
    ],
    flows: {
      [FLOW]: {
        label: 'MXL-1',
        originNode: 'worker-1',
        mirrors: [
          {
            name: 'm',
            sourceNode: 'worker-1',
            targetNode: 'worker-7',
            provider: 'tcp',
            phase: mirrorPhase,
          },
        ],
      },
    },
  };
}

describe('MonitorPage', () => {
  let fixture: ComponentFixture<MonitorPage>;
  let http: HttpTestingController;

  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  async function poll(body: MonitorResponse): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.match((r) => r.url === '/api/monitor').forEach((r) => r.flush(body));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [MonitorPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MonitorPage);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    http.match(() => true).forEach((r) => r.cancelled || r.flush({}));
  });

  it('shows each reader with its node, its flow and the mirror that feeds it', async () => {
    await poll(response(status()));
    expect(text()).toContain('generator-bars-r0001');
    expect(text()).toContain('on worker-7');
    expect(text()).toContain('MXL-1');
    expect(text()).toContain('delivering');
    expect(text()).toContain('worker-1 -> worker-7 over tcp, Ready');
  });

  it('flags a mirror that is not ready as a problem', async () => {
    await poll(response(status(), 'Failed'));
    fixture.componentInstance['problemsOnly'].set(true);
    fixture.detectChanges();
    expect(text()).toContain('worker-1 -> worker-7 over tcp, Failed');
  });

  it('counts problems since the test started, not since the reader booted', async () => {
    await poll(response(status({ too_late: 7 })));
    expect(text()).toContain('too late 7');
    fixture.componentInstance['startTest']();
    fixture.detectChanges();
    const problems = () =>
      [...fixture.nativeElement.querySelectorAll('.mon-tile')].find((t) =>
        (t as HTMLElement).textContent?.includes('problems'),
      ) as HTMLElement;
    expect(problems().textContent).toContain('0');
    expect(problems().textContent).toContain('this test');
  });

  it('lists a problem in the feed the poll it appears', async () => {
    await poll(response(status()));
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await poll(
      response(
        status({ illegal_values: 3 }, { lastError: { message: 'v210 code 0', secondsAgo: 0 } }),
      ),
    );
    const feed = fixture.nativeElement.querySelector('.mon-feed') as HTMLElement;
    expect(feed.textContent).toContain('illegal values +3: v210 code 0');
  }, 10000);

  it('shows a delivering flow of the wrong format as bad, not as live', async () => {
    await poll(response(status({}, { formatMismatch: '1920x1080 where 1296x720 was expected' })));
    const dots = [...fixture.nativeElement.querySelectorAll('.mon-flow .dot')] as HTMLElement[];
    expect(dots[0].classList).toContain('bad');
    expect(text()).toContain('expected otherwise: 1920x1080 where 1296x720 was expected');
  });

  it('names a reader it cannot ask instead of hiding it', async () => {
    const body = response(status());
    body.readers[0].status = null;
    body.readers[0].statusError = 'not provisioned yet';
    await poll(body);
    expect(text()).toContain('not provisioned yet');
  });
});
