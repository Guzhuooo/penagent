// Lightweight Markdown-to-plain-text formatter for the pen UI. The device has
// no rich text/Markdown renderer, so this intentionally keeps the meaning but
// removes syntax that would otherwise leak as punctuation. It never interprets
// HTML or executes anything.
export function formatPlainText(input) {
  if (typeof input !== 'string' || !input) return '';
  let text = input.replace(/\r\n?/g, '\n');
  // Fenced code: keep the code, drop the fence and language marker.
  text = text.replace(/```[A-Za-z0-9_+-]*[ \t]*\n?/g, '');
  text = text.replace(/`([^`\n]{1,400})`/g, '$1');
  // Headings and blockquotes.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  text = text.replace(/^[ \t]{0,3}>[ \t]?/gm, '');
  // Images and links: keep readable text plus URL.
  text = text.replace(/!\[([^\]\n]{0,200})\]\(([^)\s]{1,500})\)/g, '$1 $2');
  text = text.replace(/\[([^\]\n]{1,200})\]\(([^)\s]{1,500})\)/g, '$1 ($2)');
  // Bold/italic/strikethrough markers (bounded, line-local).
  text = text.replace(/\*\*([^*\n]{1,500})\*\*/g, '$1');
  text = text.replace(/__([^_\n]{1,500})__/g, '$1');
  text = text.replace(/~~([^~\n]{1,500})~~/g, '$1');
  text = text.replace(/\*([^*\n]{1,300})\*/g, '$1');
  text = text.replace(/_([^_\n]{1,300})_/g, '$1');
  // Lists: use a middle dot for bullets and keep numbered lists.
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '· ');
  text = text.replace(/^[ \t]*(\d+)[.)][ \t]+/gm, '$1. ');
  // Horizontal rules and raw HTML-ish tags that should never reach the device.
  text = text.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '');
  text = text.replace(/<[^>\n]{1,80}>/g, '');
  // Markdown table separators become single spaces; content is kept row by row.
  text = text.replace(/^[ \t]*\|?[ \t:|-]{3,}\|?[ \t]*$/gm, '');
  text = text.replace(/[ \t]*\|[ \t]*/g, '  ');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return text.trim();
}
