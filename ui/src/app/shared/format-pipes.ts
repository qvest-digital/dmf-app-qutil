import { Pipe, PipeTransform } from '@angular/core';

/** Everything unknown reads as "--" rather than 0, NaN or an empty cell. */
const UNKNOWN = '--';

/** Fixed-decimal number, or "--" when there is nothing to show. */
@Pipe({ name: 'fmt' })
export class FmtPipe implements PipeTransform {
  transform(n: number | null | undefined, digits = 0): string {
    if (n == null || Number.isNaN(n)) return UNKNOWN;
    return Number(n).toFixed(digits);
  }
}

/**
 * A duration in seconds, coarsening as it grows. The operator-flows payload
 * pre-computes ages server-side, where the CR timestamps are.
 */
export function agoSeconds(s: number | null | undefined): string {
  if (s == null) return UNKNOWN;
  const secs = Math.max(0, s);
  if (secs < 90) return `${secs.toFixed(0)}s`;
  if (secs < 5400) return `${(secs / 60).toFixed(0)}m`;
  if (secs < 172800) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

@Pipe({ name: 'agoS' })
export class AgoSPipe implements PipeTransform {
  transform(s: number | null | undefined): string {
    return agoSeconds(s);
  }
}

/** The same, from an ISO timestamp — for payloads that ship the stamp itself. */
@Pipe({ name: 'ago' })
export class AgoPipe implements PipeTransform {
  transform(iso: string | null | undefined): string {
    if (!iso) return UNKNOWN;
    return agoSeconds((Date.now() - Date.parse(iso)) / 1000);
  }
}

/** Container images are long and the registry prefix is never the interesting part. */
@Pipe({ name: 'shortImg' })
export class ShortImgPipe implements PipeTransform {
  transform(s: string | null | undefined): string {
    if (!s) return UNKNOWN;
    return s.replace(/^.*\//, '').slice(0, 40);
  }
}

/** The HH:MM:SS slice of an event's ISO timestamp, as the booking log shows it. */
@Pipe({ name: 'clockTime' })
export class ClockTimePipe implements PipeTransform {
  transform(iso: string | null | undefined): string {
    return (iso ?? '').slice(11, 19);
  }
}
