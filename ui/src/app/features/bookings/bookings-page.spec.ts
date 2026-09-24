import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BookingsResponse } from '../../core/api/models';
import { BookingsPage } from './bookings-page';

function response(over: Partial<BookingsResponse> = {}): BookingsResponse {
  return {
    namespace: 'production-demo-app',
    enabled: true,
    max: 2,
    bookings: [],
    ...over,
  };
}

/**
 * The page books any class and lists only what it booked: the aggregator selects
 * by its own component label, so neither the chart's claims nor the Generators
 * page's are here or deletable from here.
 */
describe('BookingsPage', () => {
  let fixture: ComponentFixture<BookingsPage>;
  let http: HttpTestingController;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  function set(name: string, value: string): void {
    const el = (fixture.nativeElement as HTMLElement).querySelector(
      `[name="${name}"]`,
    ) as HTMLInputElement;
    el.value = value;
    el.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  async function load(body: BookingsResponse): Promise<void> {
    TestBed.configureTestingModule({
      imports: [BookingsPage],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(BookingsPage);
    fixture.detectChanges();
    await new Promise((resolve) => setTimeout(resolve, 0));
    http.match((req) => req.url === '/api/bookings').forEach((req) => req.flush(body));
    fixture.detectChanges();
    await fixture.whenStable();
  }

  afterEach(() => http?.verify({ ignoreCancelled: true }));

  it('sends the typed YAML as the claim parameters', async () => {
    await load(response());
    set('className', 'mxl-writer');
    set('params', 'flow:\n  group_hint: w\n  video_output:\n    id: aaaa\n');
    (fixture.nativeElement as HTMLElement)
      .querySelector('form')!
      .dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    const req = http.expectOne('/api/bookings');
    expect(req.request.method).toBe('POST');
    expect(req.request.body.className).toBe('mxl-writer');
    // YAML in the box, JSON on the wire: the aggregator is stdlib only.
    expect(req.request.body.parameters).toEqual({
      flow: { group_hint: 'w', video_output: { id: 'aaaa' } },
    });
    req.flush({ name: 'booked-w-1a2b', className: 'mxl-writer', phase: 'Pending' });
  });

  /** A parse error has to stop at the form: the aggregator would take the POST
   *  and book a claim whose parameters the provisioner cannot read. */
  it('refuses to post parameters that are not a mapping', async () => {
    await load(response());
    set('className', 'mxl-writer');
    set('params', '- one\n- two');
    (fixture.nativeElement as HTMLElement)
      .querySelector('form')!
      .dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    http.expectNone('/api/bookings');
    expect(text()).toContain('mapping');
  });

  it('refuses a class name Kubernetes would not take', async () => {
    await load(response());
    set('className', 'Not A Class');
    (fixture.nativeElement as HTMLElement)
      .querySelector('form')!
      .dispatchEvent(new Event('submit'));
    fixture.detectChanges();

    http.expectNone('/api/bookings');
    expect(text()).toContain('usable class name');
  });

  it('says so rather than offering a form when booking is off', async () => {
    await load(response({ enabled: false }));
    expect(text()).toContain('switched off');
    expect((fixture.nativeElement as HTMLElement).querySelector('form')).toBeNull();
  });

  it('stops booking at the install ceiling', async () => {
    await load(
      response({
        bookings: [
          { name: 'booked-a-1111', className: 'mxl-writer', phase: 'Bound' },
          { name: 'booked-b-2222', className: 'mediamtx', phase: 'Bound' },
        ],
      }),
    );
    const button = (fixture.nativeElement as HTMLElement).querySelector(
      '.gen-book',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(text()).toContain('Release one first');
  });
});
