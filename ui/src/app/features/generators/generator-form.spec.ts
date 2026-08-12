import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { GeneratorsResponse } from '../../core/api/models';
import { GeneratorForm } from './generator-form';

const LIMITS: GeneratorsResponse = {
  namespace: 'production-demo-app',
  className: 'mxl-writer',
  enabled: true,
  max: 8,
  ttls: ['1h', '8h', '24h', 'none'],
  patterns: ['smpte', 'ball', 'gamut'],
  animated: ['ball'],
  frameSizes: [
    { width: 1296, height: 720 },
    { width: 1920, height: 1080 },
  ],
  grainRates: [{ numerator: 30000, denominator: 1001 }],
  sampleRates: [48000],
  generators: [],
};

const VIDEO_ID = '3f2c8a1e-1111-4222-8333-444455556666';
const AUDIO_ID = '9b1d0000-2222-4333-8444-555566667777';

/**
 * What matters here is the wire body: spec.parameters is validated by nothing, so
 * a wrong field name books a writer that quietly runs the class defaults -- and
 * the class default for a video id is one shared UUID.
 */
describe('GeneratorForm', () => {
  let fixture: ComponentFixture<GeneratorForm>;
  let http: HttpTestingController;

  function flushIds(): void {
    http
      .expectOne('/api/generators/flow-ids')
      .flush({ videoFlowId: VIDEO_ID, audioFlowId: AUDIO_ID });
    fixture.detectChanges();
  }

  function field(id: string): HTMLInputElement {
    return fixture.nativeElement.querySelector(`#${id}`);
  }

  function bookButton(): HTMLButtonElement {
    return [...fixture.nativeElement.querySelectorAll('button')].find((b) =>
      (b as HTMLButtonElement).textContent?.includes('Book generator'),
    ) as HTMLButtonElement;
  }

  function type(input: HTMLInputElement, value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [GeneratorForm],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(GeneratorForm);
    fixture.componentRef.setInput('limits', LIMITS);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    http.match(() => true).forEach((req) => req.flush({}));
    http.verify();
  });

  it('asks the server for flow ids rather than minting its own', () => {
    flushIds();
    expect(field('gen-video-id').value).toBe(VIDEO_ID);
  });

  it('posts the parameters the aggregator expects', () => {
    flushIds();
    type(field('gen-label'), 'Bars 1');
    bookButton().click();

    const req = http.expectOne((r) => r.method === 'POST' && r.url === '/api/generators');
    expect(req.request.body).toEqual({
      label: 'Bars 1',
      ttl: '1h',
      video: {
        enabled: true,
        id: VIDEO_ID,
        pattern: 'smpte',
        overlayText: '',
        frameWidth: 1296,
        frameHeight: 720,
        grainRate: { numerator: 30000, denominator: 1001 },
      },
      audio: { enabled: false, id: AUDIO_ID, sampleRate: 48000, channelCount: 2 },
    });
    req.flush({ name: 'generator-bars-1-7f3a' });
  });

  it('emits the created generator and re-rolls the ids', () => {
    flushIds();
    const created: string[] = [];
    fixture.componentInstance.created.subscribe((g) => created.push(g.name));

    bookButton().click();
    http.expectOne('/api/generators').flush({ name: 'generator-x-0001' });
    fixture.detectChanges();

    expect(created).toEqual(['generator-x-0001']);
    // A second booking must not reuse the first one's flow id.
    http.expectOne('/api/generators/flow-ids').flush({
      videoFlowId: 'aaaaaaaa-1111-4222-8333-444455556666',
      audioFlowId: 'bbbbbbbb-2222-4333-8444-555566667777',
    });
    fixture.detectChanges();
    expect(field('gen-video-id').value).toBe('aaaaaaaa-1111-4222-8333-444455556666');
  });

  it('will not post while a rule fails, and says which', () => {
    flushIds();
    type(field('gen-video-id'), 'd4d00000-0000-0000-0000-0000000000');

    expect(bookButton().disabled).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'must be a full UUID, all 36 characters of it',
    );
  });

  it('shows the server sentence when a booking is refused', () => {
    flushIds();
    bookButton().click();
    http.expectOne('/api/generators').flush(
      {
        error:
          'flow id 3f2c8a1e-1111-4222-8333-444455556666 is already in use by claim writer-mxl-1',
      },
      { status: 409, statusText: 'Conflict' },
    );
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'is already in use by claim writer-mxl-1',
    );
  });

  it('clears the server sentence once the operator edits the field', () => {
    flushIds();
    bookButton().click();
    http
      .expectOne('/api/generators')
      .flush({ error: 'flow id is already in use' }, { status: 409, statusText: 'Conflict' });
    fixture.detectChanges();

    type(field('gen-video-id'), 'cccccccc-1111-4222-8333-444455556666');
    expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('already in use');
  });
});
