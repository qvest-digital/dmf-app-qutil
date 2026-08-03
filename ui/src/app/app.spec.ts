import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { routes } from './app.routes';

/**
 * A smoke test for the shell's composition: the header, the four tabs and the
 * preview overlay all have to come up together, and each of them pulls in a
 * different provider (router, HttpClient) that is easy to forget.
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

    expect(el.querySelector('.brand .sub')?.textContent).toContain('MXL Utility');
    expect(el.querySelector('.logo svg')).toBeTruthy();
    expect(el.querySelector('.pill b')?.textContent).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('offers one tab per route', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const tabs = [...fixture.nativeElement.querySelectorAll('.tab')] as HTMLAnchorElement[];

    expect(tabs.map((t) => t.textContent!.trim())).toEqual([
      'Multiviewer',
      'SRT Camera',
      'Composite',
      'Booking',
    ]);
    expect(tabs.map((t) => t.getAttribute('href'))).toEqual(['/', '/srt', '/cp', '/bk']);
  });

  // It must exist from the start but stay hidden: the <video> it owns has to be
  // stable across previews, because createMediaElementSource can only be called
  // once per element.
  it('mounts the preview overlay closed', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const overlay = fixture.nativeElement.querySelector('.pv') as HTMLElement;

    expect(overlay).toBeTruthy();
    expect(overlay.classList.contains('show')).toBe(false);
  });
});
