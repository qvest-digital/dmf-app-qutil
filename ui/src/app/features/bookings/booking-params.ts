import { parse } from 'yaml';

/**
 * Turning the typed parameters into what the claim carries.
 *
 * The aggregator takes JSON and validates nothing beyond it being a mapping: no
 * class publishes a parameter schema, so a mistyped key reaches the provisioner
 * as typed. Parsing here is what turns a typo into a message on the form rather
 * than a claim that never provisions.
 */
export interface ParsedParams {
  value: Record<string, unknown> | null;
  error: string;
}

export function parseParams(text: string): ParsedParams {
  const trimmed = text.trim();
  // Empty is a booking with no parameters, which is what a class whose defaults
  // are enough takes.
  if (!trimmed) return { value: {}, error: '' };

  let parsed: unknown;
  try {
    parsed = parse(trimmed);
  } catch (e) {
    return { value: null, error: (e as Error).message.split('\n')[0] };
  }

  if (parsed === null || parsed === undefined) return { value: {}, error: '' };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'parameters must be a mapping of keys to values' };
  }
  return { value: parsed as Record<string, unknown>, error: '' };
}

/** A class name is a Kubernetes object name, the same rule the aggregator applies. */
const CLASS_RE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

export function classError(className: string): string {
  const name = className.trim();
  if (!name) return 'a class name is required';
  if (name.length > 253 || !CLASS_RE.test(name)) return 'that is not a usable class name';
  return '';
}
