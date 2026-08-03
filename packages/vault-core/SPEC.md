# vault-core — implementation spec

Core vault access. **Knows nothing about MCP.** No runtime dependencies beyond
`node:` builtins. Types live in `src/types.ts`, errors in `src/errors.ts`
(already written — do not change their public shape). `src/index.ts` re-exports
everything public.

Source layout: `src/vault.ts` (openVault), `src/paths.ts`, `src/io.ts`,
`src/search.ts`, `src/recent.ts`, `src/daily.ts`, `src/index.ts`.
TS is NodeNext ESM: relative imports need the `.js` extension.

## openVault(opts: VaultOptions): Promise<Vault>

- Verifies `root` is an absolute path to an existing directory; resolves it with
  `fs.realpath` and stores the resolved value.
- Normalizes `lowTrustFolders`: trim, strip leading/trailing slashes, drop empties.
- `maxReadBytes` default 200_000.
- Throws `VaultError('NOT_FOUND' | 'INVALID_PATH', ...)` on bad root.

## resolveNotePath(vault, relPath, opts?: { forCreate?: boolean }): Promise<string>

Returns the absolute filesystem path. This is the single chokepoint every tool
goes through. Rules, all enforced with `VaultError` codes:

- `INVALID_PATH`: empty, contains `\0`, contains a backslash, is absolute,
  starts with `~`, contains a `.` or `..` segment, ends with `/`, or a segment
  contains an invisible/control character (C0/C1 + newlines, U+00AD,
  U+200B–U+200F, U+202A–U+202E, U+2060–U+2064, U+FEFF, U+E0000–U+E007F). A note
  *name* carrying those is a prompt-injection channel that no content sanitizer
  can close, and the error message must NOT echo the offending segment. Table
  duplicated from `packages/vault-guards/src/invisible.ts` (vault-core has no
  dependencies) — keep both in sync.
- `NOT_MARKDOWN`: extension is not `.md` (case-insensitive accept, e.g. `.MD` ok).
- `HIDDEN_PATH`: any segment starting with `.` (covers `.obsidian`, `.git`,
  `.trash`, hidden files) — checked before touching the filesystem, **and
  re-checked against the symlink-resolved vault-relative path**, so a directory
  symlink inside the vault pointing at a dot-directory is rejected too.
- `OUTSIDE_VAULT`: after the string checks, resolve symlinks and verify
  containment: for reads, `realpath(dirname(target))` must be the vault root or
  a descendant (string prefix check against `vault.root + sep`). For
  `forCreate`, walk up to the deepest **existing** ancestor, realpath that, and
  check containment (missing intermediate dirs will be created as real dirs).
- The note itself must not be a symlink: `lstat` (when it exists) → if symlink,
  `OUTSIDE_VAULT`.
- `NOT_A_FILE` when the path exists but is a directory.

Also export `toVaultRelative(vault, absPath): string` (forward slashes) for
building results.

## readNote(vault, relPath): Promise<NoteContent>

- `NOT_FOUND` if missing.
- If size > `maxReadBytes`: return the first `maxReadBytes` bytes decoded as
  UTF-8 **without a broken trailing code point** (slice buffer, then trim any
  incomplete multibyte sequence at the end), `truncated: true`. `sizeBytes` is
  always the full on-disk size.

## createNote(vault, relPath, content): Promise<{ path: string }>

Atomic and exclusive — the sync watcher must never observe a half-written file,
and an existing note must never be clobbered:

1. `resolveNotePath(..., { forCreate: true })`; create parent dirs (recursive).
2. Write content to a temp file in the **same directory**, named
   `.<basename>.<random>.tmp` (dot-prefixed so sync ignores it), `fsync` it.
   If the write or the fsync fails (ENOSPC/EDQUOT/EIO), unlink the temp file
   before propagating — a leaked dot-file is invisible to the user.
3. `fs.link(tmp, target)` — `EEXIST` → `VaultError('ALREADY_EXISTS')`.
4. Unlink tmp; best-effort `fsync` of the directory.

## appendToNote(vault, relPath, content): Promise<{ path: string; sizeBytes: number }>

- `NOT_FOUND` if the note doesn't exist (callers create first — append never
  creates, never overwrites semantically).
- Read current content; join with exactly one `\n` boundary (add one if the
  existing content doesn't end with a newline and is non-empty); ensure the
  result ends with `\n`.
- Write via temp file + `fsync` + `rename` over the target (atomic replace).

## searchNotes(vault, query, opts): Promise<SearchMatch[]>

- Recursive walk of `.md` files; skip any dot-directory/dot-file; skip
  `lowTrustFolders` (prefix match on vault-relative path) unless
  `includeLowTrust`.
- Case-insensitive **literal substring** match per line (no regex — query is
  untrusted input).
- `limit` default 20, hard cap 50. Deterministic order: path ascending, then
  line number. Snippet: the trimmed line, capped at 200 chars centered on the
  match when possible. Skip files larger than 5_000_000 bytes.
- Walk must not follow directory symlinks (`withFileTypes`, don't recurse into
  `isSymbolicLink()` entries).

## listRecent(vault, opts): Promise<RecentNote[]>

Same walk rules (dot-dirs skipped, no symlink traversal; low-trust **included**
— paths only, no content). Sort mtime desc, `limit` default 10 cap 50,
`modifiedAt` ISO 8601.

## getDailyNote(vault, date?): Promise<DailyNoteInfo>

- Reads `<root>/.obsidian/daily-notes.json` directly (trusted internal read —
  NOT through resolveNotePath). Missing/invalid file → Obsidian defaults:
  `{ folder: "", format: "YYYY-MM-DD" }`.
- `date` is `YYYY-MM-DD` (validate; `INVALID_PATH`-style errors are wrong here —
  throw `VaultError('INVALID_PATH', 'invalid date ...')` is fine); default today
  in server-local time. Construct the Date at local **noon** to dodge DST edges.
- Format the filename with a moment-subset formatter (implement in
  `src/daily.ts`, export `formatDailyName(format, date)` for tests):
  tokens `YYYY YY MMMM MMM MM M DD D dddd ddd`, `[literal]` bracket escapes,
  en-US names. The format may contain `/` (subfolders).
- Resulting relative path = `folder` + formatted + `.md`, validated through
  `resolveNotePath` (a hostile config surfaces as a VaultError, never an
  escape). Exists → include `note` via readNote. **Never creates the file.**
- `DailyNoteInfo.date` always carries the resolved day as `YYYY-MM-DD`, even
  when the caller passed no date or the format hides it (`dddd` → `Monday.md`),
  so callers never have to say "today".

## Tests (test/*.test.ts, vitest, tmp dirs via fs.mkdtemp in os.tmpdir())

Path escape suite is the M0 acceptance gate — cover at least:
`../x.md`, `a/../../x.md`, `/etc/passwd.md`, `~/x.md`, `a/../b.md` (has `..`),
`.obsidian/app.json`, `.obsidian/note.md`, `a/.hidden/x.md`, `x.md/`, `a\\b.md`,
`"" `, `x\0.md`, `x.txt`, symlinked dir inside vault pointing outside (create
real target outside, symlink inside, expect OUTSIDE_VAULT on read and create),
symlinked file pointing outside, directory named `x.md`.
Plus: atomic create (content appears fully or not at all; ALREADY_EXISTS on
second create), append newline-boundary cases (file with/without trailing
newline), truncation on multibyte boundary (e.g. 'é'/emoji straddling the cut),
search casing + low-trust exclusion/inclusion + limit + determinism, recent
ordering, daily-note config honored (custom folder/format e.g.
`journal/YYYY/MM/YYYY-MM-DD` + `[day] DD` literal), config missing → defaults,
absent daily note → exists:false with correct path.
