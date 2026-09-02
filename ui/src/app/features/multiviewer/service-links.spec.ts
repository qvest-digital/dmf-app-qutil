import { ComponentFixture, TestBed } from '@angular/core/testing';
import { BookedService } from '../../core/api/models';
import { ServiceLinks } from './service-links';

const EXPOSED: BookedService = {
  claim: 'mcm',
  endpoints: [{
    name: 'ui',
    url: 'https://mcm.p-demo:443',
    api: 'https',
    externalUrl: 'https://mcm-p-demo.dmf.example.com',
  }],
};

const INTERNAL_ONLY: BookedService = {
  claim: 'mediamtx',
  endpoints: [{ name: 'rtsp', url: 'rtsp://mediamtx-origin.p-demo:8554' }],
};

describe('ServiceLinks', () => {
  let fixture: ComponentFixture<ServiceLinks>;

  const render = (services: BookedService[]) => {
    fixture.componentRef.setInput('services', services);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [ServiceLinks] }).compileComponents();
    fixture = TestBed.createComponent(ServiceLinks);
  });

  it('links the external address', () => {
    const anchor = render([EXPOSED]).querySelector('a');
    expect(anchor?.getAttribute('href')).toBe('https://mcm-p-demo.dmf.example.com');
  });

  it('does not link an in-cluster address', () => {
    // A browser cannot resolve a Service name, so offering one as a link hands
    // the reader something that fails without saying why.
    const el = render([INTERNAL_ONLY]);
    expect(el.querySelector('a')).toBeNull();
    expect(el.textContent).toContain('rtsp://mediamtx-origin.p-demo:8554');
  });

  it('says so when nothing is booked', () => {
    expect(render([]).textContent).toContain('no booked services');
  });
});
