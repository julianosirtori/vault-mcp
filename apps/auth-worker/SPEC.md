# auth-worker — implementation spec

Cloudflare Worker at the edge: OAuth 2.1 + authenticated proxy. It never reads
vault content and stores nothing but OAuth state. Built on
`@cloudflare/workers-oauth-provider` (installed — read its README/types in
node_modules for the real API; implement against what actually exists, and
document any spec-vs-library gap in the code).

Layout: `src/index.ts` (OAuthProvider wiring), `src/api-handler.ts` (proxy to
origin), `src/consent.ts` (authorize UI + checks), `wrangler.jsonc` (example,
placeholder IDs only), `README.md` (deploy steps). tsconfig is Bundler-mode
(extensionless imports fine). Typecheck must pass: `pnpm --filter
@vault-mcp/auth-worker typecheck`. No tests required (no workerd here).

## Bindings / vars (all documented in wrangler.jsonc comments, no real values)

- `OAUTH_KV` (KV) — token/grant storage for the library, plus rate-limit keys.
- `ORIGIN_URL` (var) — tunnel hostname of the origin.
- `ORIGIN_SECRET` (secret) — shared secret; added as `x-origin-secret` on every
  forwarded request. The public URL is NOT a secret; this is.
- `CONSENT_PASSWORD` (secret) — high-entropy consent credential.
- `REDIRECT_ALLOWLIST` (var) — comma-separated exact `redirect_uri` values
  (e.g. Claude callbacks plus ChatGPT's connector-specific
  `https://chatgpt.com/connector/oauth/<callback_id>`). ChatGPT's callback ID
  is normally stable for a connector instance but may change when it is
  recreated; never replace the exact entry with a wildcard.
- `COOKIE_SECRET` (secret) — if the library needs one for signed state.

## Behavior

- `OAuthProvider` handles `/.well-known/*`, `/token`, `/register` (dynamic
  registration stays enabled for compatibility; the redirect allowlist is what
  neutralizes rogue registrations). `apiRoute: '/mcp'` → api handler.
- **Api handler**: forward method/body/relevant headers to
  `${ORIGIN_URL}/mcp`, attach `x-origin-secret`, stream the response back.
  Never forward cookies or the client's Authorization header to the origin.
- **Authorize flow** (default handler): parse the OAuth request via the
  library; **reject any `redirect_uri` not exactly in REDIRECT_ALLOWLIST**
  (single-user system: this closes the rogue-client class entirely). GET →
  minimal self-contained HTML consent page (no external assets) showing
  client + scopes, with a password field. POST → verify password by comparing
  SHA-256 digests via `crypto.subtle` (constant-time by construction), enforce
  attempt limiting in KV: key `consent-attempts:<ip>`, max 5 per 15 min (TTL),
  429 after. Success → `completeAuthorization`, redirect.
- Failures give minimal information; log to console (Workers logs) not to the
  response.

## README.md must cover

create KV namespace, set secrets via `wrangler secret put`, set vars, deploy,
add the connector URL in Claude or ChatGPT settings, document ChatGPT's exact
connector callback and its lifecycle, and explain how the allowlist blocks
rogue dynamic registrations. State plainly what the Worker can and cannot see.
