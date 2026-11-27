// HTML to readable text without a DOM or dependencies: drop what is not content (scripts,
// styles, head, embedded documents), keep the structure that matters to a reader (headings,
// paragraphs, list items, table cells, preformatted text) and the targets of links.
// A single forward scan with indexOf, never a regex over the document: pages are untrusted and
// up to the size cap, so the work must stay linear in their length (no backtracking).

// Not 'head': </head> may be left out, and what the head holds that is not text (title, script,
// style) is dropped by its own tag; meta and link produce nothing anyway.
// math, object (its fallback) and select (its options) hold visible text: kept.
const DROP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'title']);
/** Foreign elements, where `/>` really closes the element (in HTML proper it is ignored). */
const FOREIGN = new Set(['svg', 'math']);
const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'footer', 'form', 'header', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'tfoot', 'thead', 'tr', 'ul',
]);
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•', times: '×', deg: '°', euro: '€',
};
/** Link labels longer than this are not compared with their target (keeps nested links linear). */
const LABEL_SCAN = 64;

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,8}|[a-z][a-z0-9]{0,31});/gi, (whole, e: string) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? whole;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
  });
}

const isNameStart = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isNameChar = (c: number) => isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 58 || c === 95;
const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;

/**
 * The index of the `>` that ends a tag starting at `from`, skipping quoted attribute values; -1 if
 * none. A quote opens a value only right after `=` (an apostrophe in `title=don't` is text), and a
 * value whose quote never closes ends at the next `>`, as browsers recover.
 */
function tagEnd(s: string, from: number): number {
  let afterEquals = false;
  for (let i = from; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 62) return i;
    if (c === 61) { afterEquals = true; continue; }
    if (afterEquals && (c === 34 || c === 39)) {
      const close = s.indexOf(c === 34 ? '"' : "'", i + 1);
      if (close < 0) return s.indexOf('>', i + 1);
      i = close;
    }
    if (!isSpace(c)) afterEquals = false;
  }
  return -1;
}

/** Where `</name` (any case) starts at or after `from`; -1 if never. Linear: each `</` is looked at once. */
function closingTag(s: string, name: string, from: number): number {
  for (let i = s.indexOf('</', from); i >= 0; i = s.indexOf('</', i + 2)) {
    if (s.slice(i + 2, i + 2 + name.length).toLowerCase() === name && !isNameChar(s.charCodeAt(i + 2 + name.length) || 0)) return i;
  }
  return -1;
}

/** One attribute's value from a tag's attribute text (short: one tag). */
function attr(attrs: string, name: string): string | undefined {
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && (isSpace(attrs.charCodeAt(i)) || attrs[i] === '/')) i++;
    const start = i;
    while (i < attrs.length && !isSpace(attrs.charCodeAt(i)) && attrs[i] !== '=' && attrs[i] !== '>') i++;
    const key = attrs.slice(start, i).toLowerCase();
    while (i < attrs.length && isSpace(attrs.charCodeAt(i))) i++;
    let value: string | undefined;
    if (attrs[i] === '=') {
      i++;
      while (i < attrs.length && isSpace(attrs.charCodeAt(i))) i++;
      const q = attrs[i];
      if (q === '"' || q === "'") { const end = attrs.indexOf(q, i + 1); value = attrs.slice(i + 1, end < 0 ? attrs.length : end); i = end < 0 ? attrs.length : end + 1; }
      else { const v = i; while (i < attrs.length && !isSpace(attrs.charCodeAt(i))) i++; value = attrs.slice(v, i); }
    }
    if (key === name) return value === undefined ? undefined : decodeEntities(value);
    if (i === start) i++; // nothing consumed: step on
  }
  return undefined;
}

/** A link target worth showing: absolute http(s) or mailto, resolved against the page. */
function linkTarget(href: string | undefined, base: string | undefined): string | null {
  if (!href || href.startsWith('#')) return null;
  try {
    const url = new URL(href.trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch { return null; }
}

/** Trailing spaces off, the single leading space left by collapsing off, at most one blank line in a row. */
function tidy(text: string): string {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let end = raw.length;
    while (end > 0 && (raw.charCodeAt(end - 1) === 32 || raw.charCodeAt(end - 1) === 9)) end--;
    let line = raw.slice(0, end);
    if (line.length > 1 && line[0] === ' ' && line[1] !== ' ') line = line.slice(1);
    if (line || (out.length && out.at(-1) !== '')) out.push(line);
  }
  while (out.at(-1) === '') out.pop();
  return out.join('\n');
}

export function htmlToText(html: string, base?: string): { title?: string; text: string } {
  const out: string[] = [];
  const links: { href: string | undefined; at: number }[] = [];
  let title: string | undefined;
  let pre = 0;
  const ends = () => { const tail = out.at(-1) ?? '\n'; return tail.endsWith(' ') || tail.endsWith('\n'); };
  const text = (s: string) => {
    if (!s) return;
    let t = decodeEntities(s);
    if (!pre) { t = t.replace(/\s+/g, ' '); if (t.startsWith(' ') && ends()) t = t.slice(1); }
    if (t) out.push(t);
  };
  const tag = (name: string, closing: boolean, attrs: string) => {
    if (name === 'pre' || name === 'textarea') { pre = closing ? Math.max(0, pre - 1) : pre + 1; out.push('\n'); }
    else if (name === 'br') out.push('\n');
    else if (name === 'hr') out.push('\n---\n');
    else if (name.length === 2 && name[0] === 'h' && name[1]! >= '1' && name[1]! <= '6') out.push(closing ? '\n\n' : `\n\n${'#'.repeat(Number(name[1]))} `);
    else if (name === 'li') { if (!closing) out.push('\n- '); }
    else if (name === 'td' || name === 'th') { if (closing) out.push(' | '); }
    else if (name === 'img') { const alt = attr(attrs, 'alt')?.trim(); if (alt) out.push(`[image: ${alt}]`); }
    else if (name === 'a') {
      if (!closing) { links.push({ href: attr(attrs, 'href'), at: out.length }); return; }
      const link = links.pop();
      if (!link) return;
      const label = out.length - link.at <= LABEL_SCAN ? out.slice(link.at).join('').replace(/\s+/g, ' ').trim() : '';
      const target = linkTarget(link.href, base);
      if (target && target !== label) out.push(` (${target})`);
    } else if (BLOCK.has(name)) out.push('\n');
  };

  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) { text(html.slice(i)); break; }
    text(html.slice(i, lt));
    if (html.startsWith('<!-->', lt)) { i = lt + 5; continue; } // empty comments
    if (html.startsWith('<!--->', lt)) { i = lt + 6; continue; }
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); if (e < 0) break; i = e + 3; continue; }
    if (html.startsWith('<![CDATA[', lt)) { const e = html.indexOf(']]>', lt + 9); text(html.slice(lt + 9, e < 0 ? html.length : e)); if (e < 0) break; i = e + 3; continue; }
    const c1 = html.charCodeAt(lt + 1);
    if (c1 === 33 || c1 === 63) { const e = html.indexOf('>', lt + 2); if (e < 0) break; i = e + 1; continue; } // <!doctype …>, <?…?>
    const closing = c1 === 47;
    const nameAt = closing ? lt + 2 : lt + 1;
    if (!isNameStart(html.charCodeAt(nameAt))) {
      if (closing) { const e = html.indexOf('>', lt + 2); if (e < 0) break; i = e + 1; continue; } // </ p>, </>: a bogus comment, hidden
      text('<'); i = lt + 1; continue; // a lone "<" is text
    }
    let nameEnd = nameAt;
    while (nameEnd < html.length && isNameChar(html.charCodeAt(nameEnd))) nameEnd++;
    const name = html.slice(nameAt, nameEnd).toLowerCase();
    const end = tagEnd(html, nameEnd);
    if (end < 0) break; // an unterminated tag runs to the end of the page: nothing readable after it
    i = end + 1;
    const selfClosing = html.charCodeAt(end - 1) === 47;
    if (!closing && name === 'textarea') { // raw text: tags and comments inside are shown as they are
      const close = closingTag(html, 'textarea', i);
      out.push('\n'); pre++; text(html.slice(i, close < 0 ? html.length : close)); pre--; out.push('\n');
      if (close < 0) break;
      const after = tagEnd(html, close + 10);
      if (after < 0) break;
      i = after + 1;
      continue;
    }
    if (!closing && DROP.has(name) && !(selfClosing && FOREIGN.has(name))) {
      const close = closingTag(html, name, i);
      if (name === 'title' && title === undefined) title = html.slice(i, close < 0 ? Math.min(html.length, i + 10_000) : close);
      if (close < 0) { if (FOREIGN.has(name)) continue; break; } // an unclosed svg: read on, as a browser leaves it at the next HTML tag
      const after = tagEnd(html, close + 2 + name.length);
      if (after < 0) break;
      i = after + 1;
      continue;
    }
    tag(name, closing, closing ? '' : html.slice(nameEnd, end));
  }
  const cleanTitle = title === undefined ? undefined : decodeEntities(title).replace(/\s+/g, ' ').trim() || undefined;
  return { title: cleanTitle, text: tidy(out.join('')) };
}
