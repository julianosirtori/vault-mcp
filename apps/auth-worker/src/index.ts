/**
 * auth-worker entrypoint: OAuth 2.1 at the edge, built on
 * `@cloudflare/workers-oauth-provider`.
 *
 * The OAuthProvider instance wraps the whole Worker:
 *
 * - `/.well-known/oauth-authorization-server` and
 *   `/.well-known/oauth-protected-resource` are served by the library.
 * - `/token` (token issuance/refresh) is implemented by the library.
 * - `/register` (RFC 7591 dynamic client registration) is implemented by the
 *   library. It stays enabled for compatibility with MCP clients; the
 *   REDIRECT_ALLOWLIST check in `consent.ts` is what neutralizes rogue
 *   registrations (see there).
 * - `/mcp` requests with a valid bearer token go to `apiHandler` (proxy to
 *   the origin). Everything else goes to `defaultHandler` (the authorize UI).
 * - `/authorize` is NOT handled by the library: the library only advertises
 *   it in the metadata. Our `defaultHandler` implements it.
 *
 * Spec-vs-library gaps (documented per SPEC.md):
 *
 * 1. COOKIE_SECRET: the spec lists it "if the library needs one for signed
 *    state". v0.10.1 of the library keeps ALL OAuth state in KV (secrets are
 *    stored only as hashes, props end-to-end encrypted) and never issues
 *    signed cookies, so no such secret exists in its API. The binding is
 *    intentionally omitted.
 * 2. The spec says the provider "handles /.well-known/*, /token, /register".
 *    True, but the library additionally REQUIRES `authorizeEndpoint` to be
 *    configured (used only for metadata discovery) — the UI itself remains
 *    the application's job, wired below through `defaultHandler`.
 * 3. `completeAuthorization()` requires `metadata` and `props` as
 *    non-optional fields; we pass minimal values (single-user system).
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import { apiHandler } from './api-handler';
import { defaultHandler } from './consent';

/**
 * Bindings / vars for this Worker. Real values are configured via
 * wrangler.jsonc (vars, KV) and `wrangler secret put` (secrets) — see the
 * comments in wrangler.jsonc and the README.
 */
export interface Env {
  /**
   * KV namespace. The library REQUIRES this exact binding name for its
   * token/grant/client storage. We additionally use it for the consent
   * attempt-limiting keys (`consent-attempts:<ip>`, see consent.ts).
   */
  OAUTH_KV: KVNamespace;

  /**
   * Tunnel hostname of the origin, e.g. `https://origin.example.com`.
   * Origin only (no path). The public URL of this Worker is not a secret;
   * this hostname is not either — the origin refuses (404) anything that
   * does not carry ORIGIN_SECRET.
   */
  ORIGIN_URL: string;

  /**
   * Shared secret attached as `x-origin-secret` to every request forwarded
   * to the origin. Secret — set via `wrangler secret put ORIGIN_SECRET`.
   */
  ORIGIN_SECRET: string;

  /**
   * High-entropy consent credential the owner types on the authorize page.
   * Secret — set via `wrangler secret put CONSENT_PASSWORD`.
   */
  CONSENT_PASSWORD: string;

  /**
   * Comma-separated EXACT `redirect_uri` values allowed to complete the
   * authorization flow. Security core: closes the rogue-dynamic-client
   * class of attack entirely (see consent.ts).
   */
  REDIRECT_ALLOWLIST: string;

  /**
   * Injected by OAuthProvider at runtime before our handlers are invoked —
   * not a wrangler binding. Gives handlers access to parseAuthRequest(),
   * lookupClient() and completeAuthorization().
   */
  OAUTH_PROVIDER: OAuthHelpers;
}

export default new OAuthProvider<Env>({
  // Requests whose path starts with /mcp and carry a valid access token are
  // routed to the api handler; the library rejects invalid/missing tokens
  // itself (401 with WWW-Authenticate) before our code runs.
  apiRoute: '/mcp',
  apiHandler,

  // Everything that is not an API request: the /authorize consent UI and a
  // minimal 404 for the rest.
  defaultHandler,

  // Advertised in RFC 8414 metadata; implemented by defaultHandler.
  authorizeEndpoint: '/authorize',
  // Implemented by the library.
  tokenEndpoint: '/token',
  // RFC 7591 dynamic registration — implemented by the library. Kept enabled
  // for client compatibility; the redirect_uri allowlist is the control that
  // makes rogue registrations useless.
  clientRegistrationEndpoint: '/register',

  // OAuth 2.1 hardening: only the S256 PKCE method is accepted. Every real
  // MCP client (including Claude) uses S256; `plain` adds nothing but risk.
  allowPlainPKCE: false,

  // Client ID Metadata Documents (the registration mechanism preferred by
  // ARCHITECTURE.md §5.1). Requires the `global_fetch_strictly_public`
  // compatibility flag — declared in wrangler.jsonc.
  clientIdMetadataDocumentEnabled: true,
});
