import { Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { EMPTY, Observable, catchError, switchMap, timer } from 'rxjs';

/**
 * Poll `source` every `intervalMs`, starting immediately, and expose the latest
 * payload as a signal.
 *
 * Errors are swallowed and the previous value kept: a transient 5xx from the
 * aggregator must not blank a panel that was showing good data a second ago.
 * The page this replaces did the same with a bare `.catch(function(){})` on
 * every fetch.
 *
 * Must be called from an injection context — the subscription is torn down with
 * whatever component or service owns it, which is how a poll stops when its
 * route is left.
 */
export function poll<T>(intervalMs: number, source: () => Observable<T>): Signal<T | null> {
  return toSignal(
    // switchMap, so a request still in flight when the next tick fires is
    // abandoned rather than allowed to land out of order behind its successor.
    timer(0, intervalMs).pipe(switchMap(() => source().pipe(catchError(() => EMPTY)))),
    { initialValue: null },
  );
}
