# vault-guards — implementation spec

Sanitization and warn-only heuristics. **Pure functions, zero dependencies,
no I/O.** The threat model: vault content is untrusted input (web clippings,
pasted PDFs); the dominant threat is prompt injection hidden from the human
but visible to the model — and, on write, content that would exfiltrate data
when the Obsidian client auto-fetches a remote image.

Source layout: `src/sanitize-read.ts`, `src/sanitize-write.ts`,
`src/heuristics.ts`, `src/invisible.ts` (shared char tables), `src/index.ts`.
NodeNext ESM: relative imports need `.js` extension.

## Shared types (export from index)

```ts
export interface SanitizationReport {
  /** Human-readable notes, e.g. "removed 2 HTML comments". Empty = clean. */
  removed: string[];
}
export interface SanitizedContent {
  content: string;
  report: SanitizationReport;
}
/** Write path only: the sanitizer's error channel. */
export interface WriteSanitizationReport extends SanitizationReport {
  /**
   * Non-empty = the content could NOT be made safe. The caller MUST refuse
   * the write (the MCP server answers `UNSAFE_CONTENT`) instead of
   * persisting half-sanitized content.
   */
  blocked: string[];
}
export interface SanitizedWriteContent {
  content: string;
  report: WriteSanitizationReport;
}
```

Both entry points take an optional `{ maxPasses }` second argument. It
exists so tests can exercise the give-up path; production callers never set
it.

## Parsing rules both paths share (`src/html.ts`)

These are security decisions, not implementation detail:

- **Tags are matched permissively and parsed quote-aware.** Candidate tags
  are any `<name`; the quote-aware work happens only when extracting
  attribute values, following the HTML5 tokenizer: a quoted value may
  contain `>`, an unquoted value keeps stray quotes and ends at whitespace
  or `>`. A tag that looks malformed is still judged, never skipped — one
  unpaired quote used to make a whole `<img src=…>` invisible to both
  sanitizers.
- **URLs are normalized before the remote test**: numeric and named HTML
  entities decoded, invisible/tag-block characters removed, ASCII tab/CR/LF
  removed, leading/trailing control characters trimmed. Both consumers of
  the text (HTML parser, CommonMark, URL parser) decode before fetching.
- **Comment stripping reaches its fixpoint inside a single scan**, and
  hidden-element stripping restarts at the splice junction after every
  removal, so nesting depth can never outrun the pass cap.

## sanitizeForModel(markdown: string): SanitizedContent  (read path)

Removes channels for instructions invisible to the human but readable by the
model. In order:

1. **HTML comments** `<!-- ... -->` — including unterminated ones (strip to
   end of input). Count them in the report.
2. **`<script>` and `<style>` blocks** — entire element including content.
3. **Elements hidden via inline style or attribute** — any HTML element whose
   opening tag matches `hidden` attribute or `style` containing
   `display:none`, `visibility:hidden`, `font-size:0`, `opacity:0`
   (whitespace-insensitive). Strip the element with its content up to the
   matching close of that same tag name (non-greedy; nested same-tag not
   required — document the limitation in a comment). Handle self-closing tags.
4. **Invisible characters**: U+200B–U+200F, U+202A–U+202E, U+2060–U+2064,
   U+FEFF, U+00AD.
5. **Unicode tag block** U+E0000–U+E007F entirely (this is the "invisible
   instructions" alphabet).
6. **Obsidian comments** `%%…%%` — Obsidian's own comment syntax renders as
   nothing in reading view and live preview, which makes it the most
   idiomatic hiding place in a vault. Unpaired `%%` is literal text and is
   left alone.

Report each category with counts. Do NOT touch fenced code blocks' visible
content beyond the char stripping — code blocks are legitimate note content;
comment/element stripping applies to raw HTML wherever it appears (stripping
inside code fences too is acceptable for v1; note it).

## sanitizeForWrite(markdown: string): SanitizedContent  (write path)

Closes the remote-image exfiltration channel and refuses invisible payloads:

1. **De-embed remote markdown images**: `![alt](http://…)`, `![alt](https://…)`,
   `![alt](//…)` → `[alt](url)` (link stays, auto-fetch is gone). Titles in the
   target (`![a](url "t")`) preserved as links. Vault-relative and `data:`
   images left alone? No — strip `data:` images too (can smuggle payloads);
   local/relative images untouched.
2. **Reference-style images**: `![alt][ref]` → `[alt][ref]`, and bare
   `![alt]` shorthand → `[alt]` — de-embed all reference-style image usages
   (whether the definition is remote can't be decided locally per-usage;
   de-embedding is harmless for local refs: it degrades to a link).
3. **HTML fetch-vectors**: `<img>`, `<source>`, `<video>`, `<audio>`, `<iframe>`,
   `<embed>`, `<object>`, `<link>` tags whose src/href/data/srcset/poster/
   background points to `http(s)://` or `//` → replace tag with
   `[external content removed: <url>]`. Also `<img ... srcset=...>` with
   remote candidates. A fetch-vector tag that merely *mentions* a remote
   address anywhere in its source is replaced too: unparseable means
   hostile, never skipped.
4. **CSS `url()` in a `style` attribute on ANY element** — it fetches
   exactly like `<img src>`, so a remote target replaces the tag.
5. **Obsidian comments** `%%…%%` — the model has no legitimate reason to
   persist content invisible to the vault's owner.
6. **Invisible chars + Unicode tag block** — same tables as read path.

De-embedding is terminal: the whole run of leading `!` is neutralized at
once (`!!!![a](https://…)` → `[a](https://…)`), so one pass reaches a
fixpoint. If the loop ever ends with hostile content still present, the
detectors run once more and the result is reported in `report.blocked` for
the caller to refuse — the pass cap must never be what decides safety.

## detectSuspiciousContent(markdown: string): string[]  (warn-only, NEVER blocks)

Returns human-readable warnings; trivially bypassable by design — its job is
alerting the owner, not enforcement (keyword filters false-positive on the
owner's own notes about the subject). Detect at least: "ignore
previous/prior/above instructions" variants, "disregard ... instructions",
"you are now"/"act as" jailbreak phrasing, attempts to address the assistant
("assistant:", "system:" at line start), URLs with data-bearing query params
(`?data=`, `?q=`+long value, `token=`, `key=`, `secret=`), base64 runs longer
than 200 chars. Case-insensitive.

## Tests (test/*.test.ts)

Real-world shaped fixtures, at minimum:
- comment mid-line, multiline comment, unterminated comment;
- `<div style="display:none">instructions</div>`, spacing variants
  (`display : none`), `visibility:hidden`, `font-size:0`, `opacity:0`,
  `hidden` attribute, self-closing, `<span hidden>`;
- zero-width joiner sequence hiding a word, BOM, soft hyphen, RTL override,
  tag-block-encoded sentence (build via String.fromCodePoint(0xE0041…));
- write path: each image form (inline, title, protocol-relative, reference,
  shorthand, local image must survive untouched, `data:` stripped), each HTML
  vector, srcset with remote candidate;
- idempotence: sanitize(sanitize(x)) === sanitize(x) for both paths;
- clean input → identical output, empty report;
- heuristics: one positive per rule + a benign note about prompt injection
  research that SHOULD still trigger (documenting warn-only is fine) and a
  plain grocery list that must not.
