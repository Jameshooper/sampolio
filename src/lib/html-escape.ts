/**
 * Escape text for interpolation into an HTML string.
 *
 * ECharts renders a tooltip `formatter`'s return value as HTML, so every
 * user- or bank-supplied string (category, group, member and transaction
 * names) must pass through this before it is concatenated into tooltip markup.
 * React-rendered text does not need it.
 */
const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]);
}
