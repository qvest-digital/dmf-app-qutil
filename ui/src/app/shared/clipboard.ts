/**
 * Put text on the clipboard, and say whether it landed.
 *
 * Two paths, because the async clipboard API is refused outside a secure
 * context and this app is often served over plain HTTP -- a port-forward to
 * http://localhost:8080, or a cluster ingress without TLS. execCommand is
 * deprecated and still the only thing that works there, so it is the fallback
 * rather than the first choice.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable -- fall through to the legacy path.
    }
  }

  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
  }
}
