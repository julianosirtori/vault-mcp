# @vault-mcp/auth-worker

Cloudflare Worker at the edge: OAuth 2.1 authorization server plus
authenticated proxy in front of the origin MCP server. Built on
[`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).

## What this Worker can and cannot see

Be plain about the trust boundary:

- **It can see**: OAuth state (client registrations, grants, token records —
  token secrets stored only as hashes, grant props end-to-end encrypted),
  consent attempt counters per IP, and the *bytes in transit* of every `/mcp`
  request and response it proxies. Anything the edge terminates TLS for, the
  edge can in principle observe.
- **It cannot see**: your vault. It has no filesystem, no vault credentials,
  and no way to reach the origin except through the tunnel — and it never
  stores request or response bodies. If the Worker (or its KV) is fully
  compromised, the attacker gets OAuth state and a proxy position, not your
  notes at rest.
- **The origin never sees**: the client's bearer token or cookies. The proxy
  forwards an allowlist of headers only and authenticates itself to the
  origin with the `x-origin-secret` shared secret. The origin answers 404
  (not 401) to anything without that secret, so probing the tunnel hostname
  confirms nothing.

## Endpoints

| Path | Implemented by | Purpose |
| --- | --- | --- |
| `/.well-known/oauth-authorization-server` | library | RFC 8414 metadata |
| `/.well-known/oauth-protected-resource` | library | RFC 9728 metadata |
| `/token` | library | Token issuance / refresh |
| `/register` | library | RFC 7591 dynamic client registration |
| `/authorize` | `src/consent.ts` | Consent page (GET) + grant (POST) |
| `/mcp` | `src/api-handler.ts` | Bearer-authenticated proxy to origin |

## Deploy

All commands run from `apps/auth-worker/`. Use `npx wrangler@latest` (or a
globally installed `wrangler`); log in first with `wrangler login`.

### 1. Create the KV namespace

```sh
cp wrangler.jsonc wrangler.local.jsonc   # git-ignored working copy
npx wrangler kv namespace create OAUTH_KV
```

Edit the untracked `wrangler.local.jsonc` — never the tracked `wrangler.jsonc`,
which is the example and must keep placeholders only. Copy the printed `id`
into `kv_namespaces[0].id` there. The binding name must stay exactly
`OAUTH_KV` — the OAuth library resolves it by name.

### 2. Set the vars

Edit `wrangler.local.jsonc`:

- `ORIGIN_URL` — the tunnel hostname of your origin, scheme + host only
  (e.g. `https://vault-origin.example.com`). Not a secret.
- `REDIRECT_ALLOWLIST` — comma-separated **exact** `redirect_uri` values
  allowed to complete authorization. Keep the Claude callbacks and add the
  exact callback shown by ChatGPT when configuring the connector:

  ```
  https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback,https://chatgpt.com/connector/oauth/<callback_id>
  ```

  ChatGPT's `<callback_id>` is normally stable for that connector instance,
  but it can change if the connector is deleted and recreated or another
  connector is created. If it changes, authorization returns `403` until the
  new exact callback is added and the Worker is redeployed. Do not replace it
  with a wildcard. The legacy callback
  `https://chatgpt.com/connector_platform_oauth_redirect` is retained only for
  already-published integrations that still use it.

### 3. Set the secrets

```sh
# Shared secret the origin requires; must match the origin's configuration.
openssl rand -base64 32   # generate a value, then:
npx wrangler secret put ORIGIN_SECRET

# High-entropy consent credential; store it in your password manager.
openssl rand -base64 32   # generate a value, then:
npx wrangler secret put CONSENT_PASSWORD
```

No `COOKIE_SECRET` is needed: library v0.10.1 keeps all OAuth state in KV and
issues no signed cookies (documented deviation from SPEC.md, which listed it
conditionally).

### 4. Deploy

```sh
npx wrangler deploy --config wrangler.local.jsonc
```

Note the deployed URL (e.g. `https://vault-mcp-auth-worker.<account>.workers.dev`,
or your custom domain).

### 5. Connect Claude or ChatGPT

In Claude → Settings → Connectors → *Add custom connector*, enter the MCP
endpoint URL:

```
https://<your-worker-domain>/mcp
```

Claude discovers the OAuth metadata, registers (or presents a Client ID
Metadata Document), and sends you to `/authorize`. Verify the client and
redirect URI shown on the consent page, enter your `CONSENT_PASSWORD`, and
approve. Repeat per Claude surface if prompted.

For ChatGPT, create the MCP connector/plugin with the same endpoint. Before
authorizing it, copy the callback URL shown by ChatGPT — typically
`https://chatgpt.com/connector/oauth/<callback_id>` — into
`REDIRECT_ALLOWLIST` and redeploy. ChatGPT identifies itself with a Client ID
Metadata Document such as `https://chatgpt.com/oauth/<callback_id>/client.json`
and then opens the same `/authorize` consent flow.

### ChatGPT client-auth compatibility

ChatGPT's Client ID Metadata Document can prefer `private_key_jwt` while also
listing `none` in `token_endpoint_auth_methods_supported`. The upstream OAuth
provider does not yet implement `private_key_jwt` for CIMD clients (see
[cloudflare/workers-oauth-provider#264](https://github.com/cloudflare/workers-oauth-provider/issues/264)).
This workspace patches v0.10.1 to negotiate `none` only when the client
explicitly lists it as supported. PKCE S256 remains mandatory, so the
authorization-code exchange is still bound to ChatGPT's code verifier. Remove
the patch after upstream supports this metadata shape directly.

## Security notes

### How the allowlist neutralizes rogue dynamic registrations

`/register` is open by specification — anyone can register a client, and they
choose their own `redirect_uris`. Without further checks, an attacker
registers a client that redirects to a domain they control, sends you a
crafted `/authorize` link on your *legitimate* domain, and if you approve,
the authorization code lands on their server.

This Worker closes that class entirely: on **every** `/authorize` request
(GET and POST), the `redirect_uri` must be an exact string member of
`REDIRECT_ALLOWLIST` — no prefix matching, no origin matching, no wildcards.
A rogue registration still "succeeds" at `/register`, but its redirect can
never pass the allowlist, so no consent page is ever rendered for it and no
grant can ever be completed toward it. Being a single-user system, a fixed
list costs nothing in flexibility.

For the same reason, do not allow every URL under
`https://chatgpt.com/connector/oauth/`: use only the callback ID assigned to
your connector. A different ChatGPT connector receives a different callback
and must not be authorized implicitly.

### Consent brute-force limiting

`POST /authorize` is limited per IP in KV: key `consent-attempts:<ip>`,
maximum 5 attempts per 15-minute window (enforced with a KV TTL), `429` once
exceeded — before any password comparison happens. Password verification
compares SHA-256 digests via `crypto.subtle`, which is constant-time by
construction. A successful consent clears the counter.

### Other properties

- OAuth 2.1 with PKCE; only the `S256` challenge method is accepted.
- Failure responses carry minimal information; details go to Workers Logs
  (`observability.enabled` in `wrangler.jsonc`).
- The consent page is fully self-contained (inline CSS, no scripts, no
  external assets) and sends a strict CSP with `frame-ancestors 'none'`.

## Development

```sh
pnpm --filter @vault-mcp/auth-worker typecheck
```

There are no tests for this package (no workerd in CI); typecheck is the gate.
