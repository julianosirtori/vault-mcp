# mcp-server — implementation spec

MCP server on the origin VPS. Streamable HTTP transport, **stateless mode**,
bound to loopback; only the tunnel reaches it. Uses `@vault-mcp/core`,
`@vault-mcp/guards`, `@vault-mcp/tool-contract` (already written — read
`packages/tool-contract/src/index.ts` and the SPECs of core/guards for exact
APIs; do not modify those packages).

Source layout: `src/config.ts`, `src/audit.ts`, `src/server.ts` (McpServer
factory + tool wiring), `src/http.ts` (node:http host, no express),
`src/main.ts` (entry), `src/index.ts` (exports for tests).
NodeNext ESM: relative imports need `.js`. SDK deep imports need `.js` too,
e.g. `@modelcontextprotocol/sdk/server/mcp.js`.

## config.ts — env only, fail fast

`loadConfig(env = process.env)`: `VAULT_PATH` (required, absolute),
`MCP_HOST` (default `127.0.0.1`), `MCP_PORT` (default 9820),
`ORIGIN_SECRET` (required unless `MCP_ALLOW_INSECURE_LOCAL=1`; if set, must be
≥ 32 chars), `LOW_TRUST_FOLDERS` (comma-separated, default `[]`),
`MAX_READ_BYTES` (default 200000). On any problem throw a single clear Error
listing every missing/invalid var (the systemd `start` script surfaces it).

## audit.ts — structured log of every tool call

`auditLog(entry)` writes one JSON line to stdout:
`{ ts, tool, path?, ok, bytes, ms, error? }` — `bytes` is the size of the
returned content, `error` is the VaultError code or 'INTERNAL'. journald
captures stdout; no file handling here.

## server.ts — buildServer(vault): McpServer

- `new McpServer({ name: 'vault-mcp', version: CONTRACT_VERSION })`.
- Register each tool from tool-contract via
  `server.registerTool(t.name, { title, description, inputSchema, annotations }, handler)`.
- **Read results** (`read_note`, `get_daily_note`, search snippets): pass
  content through `sanitizeForModel`; if the report is non-empty, append a
  final line: `[sanitizer] removed: …` so the owner can tell content was
  altered. For `search_notes` the per-snippet reports are merged into one such
  line (distinct reasons + how many snippets were altered) — silent
  sanitization is not allowed anywhere. Run `detectSuspiciousContent` on
  returned content; non-empty → append `[warning] …` lines (warn-only, never
  block).
- **Note paths echoed to the model** (search results, `list_recent`,
  `get_daily_note`): strip invisible/control characters (same table as
  `vault-guards/src/invisible.ts` plus C0/C1) before they enter the text — a
  file *name* is model-facing content, and a newline in one would forge result
  lines. If any name was altered, say so in the `[sanitizer] removed:` line.
  Creating such a path is refused upstream by vault-core (`INVALID_PATH`).
- **Write inputs** (`create_note`, `append_to_note`): pass content through
  `sanitizeForWrite` first; mention de-embeds in the success text.
- Result formats (all `content: [{ type: 'text', text }]`):
  - search_notes: header `N matches for "q"` then `path:line: snippet` lines;
    0 matches → say so and suggest include_low_trust only if low-trust folders exist.
  - read_note: content; if truncated, prefix `[truncated: showing X of Y bytes] `.
  - list_recent: `path — ISO timestamp` lines.
  - get_daily_note: exists → same as read_note; missing →
    `Daily note for YYYY-MM-DD does not exist yet. It would be created at: <path>. Use create_note to create it (the daily-notes template will NOT be applied).`
    (and no error flag — absence is a normal answer). The date comes from
    `DailyNoteInfo.date`, never from the caller's argument, so an omitted date
    still renders a concrete day instead of "today".
  - create/append: short confirmation with the vault-relative path.
- **Errors**: catch `VaultError` → `isError: true`, message = code + safe
  message, vault-relative paths only, never absolute paths, never stack traces.
  Unknown errors → `isError: true`, generic message; full error to stderr.
- Every call goes through a wrapper that times it and calls `auditLog`.

## http.ts — createHttpServer(config, vault)

- `node:http`. Every request FIRST passes the origin gate: header
  `x-origin-secret` compared with `crypto.timingSafeEqual` (guard length
  mismatch by hashing both sides with SHA-256 first, then timingSafeEqual on
  digests). Missing/wrong → **404**, empty body — never 401, never a hint.
  Gate disabled only when `MCP_ALLOW_INSECURE_LOCAL=1` and host is loopback.
- Request bodies over 4 MB → **413** with a JSON-RPC error body. The remaining
  bytes are drained (bounded) before answering: destroying the request while
  the client is still uploading resets the connection and the client learns
  nothing.
- `POST /mcp`: stateless streamable HTTP — per request create a fresh
  `buildServer(vault)` + `new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })`,
  connect, `transport.handleRequest(req, res, parsedBody)`; close both on
  `res.close`. `GET|DELETE /mcp` → 405 (stateless: no SSE stream, no session).
- `GET /healthz` (secret still required): `{ ok: true, vault: true }` after a
  cheap vault stat.
- Anything else → 404 empty.
- Export a `start()` returning the listening server (ephemeral port support
  for tests) and graceful SIGTERM/SIGINT shutdown in main.ts.

## main.ts

loadConfig → openVault → listen → log one startup JSON line (no secrets).
Fatal errors: readable message to stderr, exit 1.

## Tests (test/*.test.ts) — integration over real HTTP

Fixture: `fs.mkdtemp` vault with a few notes incl. `.obsidian/daily-notes.json`,
a low-trust folder, a note with an HTML comment + hidden div + tag-block chars,
ephemeral port, `MCP_ALLOW_INSECURE_LOCAL` **not** used — test WITH a secret.
Client: `@modelcontextprotocol/sdk/client` + `StreamableHTTPClientTransport`
with `requestInit: { headers: { 'x-origin-secret': … } }`.

Must cover: tools/list exposes exactly the 6 contract tools; search finds and
excludes low-trust by default / includes with flag; read_note returns sanitized
content (comment/hidden/invisible gone, `[sanitizer]` note present); path
escape via tool (`../../etc/passwd.md`) → isError with OUTSIDE_VAULT/INVALID_PATH
and no absolute path in the message; create then read round-trip; create
duplicate → ALREADY_EXISTS; append to missing → NOT_FOUND; daily note for a
fixed date honors fixture config; remote image in create content is de-embedded
on disk; wrong/missing secret → HTTP 404 for /mcp and /healthz; right secret →
healthz ok. Also unit-test config.ts failure aggregation.
