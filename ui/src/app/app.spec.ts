import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

/**
 * A smoke test for the shell's composition: the header, the tab bar and the
 * routed page have to come up together, and between them they pull in providers
 * (router, HttpClient) that are easy to forget.
 */
describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes), provideHttpClient(), provideHttpClientTesting()],
    });
  });

  it('renders the brand and a running clock', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelector('.brand .sub')?.textContent).toContain('Qutil - the DMF/MXL Utility');
    expect(el.querySelector('.logo svg')).toBeTruthy();
    expect(el.querySelector('.pill b')?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('offers one tab per route', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const tabs = [...fixture.nativeElement.querySelectorAll('.tab')] as HTMLAnchorElement[];

    expect(tabs.map((t) => t.textContent!.trim())).toEqual(['Multiviewer', 'Generators']);
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual(['/', '/gen']);
  });
});
