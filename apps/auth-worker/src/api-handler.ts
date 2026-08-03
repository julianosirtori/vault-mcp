/**
 * Authenticated proxy to the origin MCP server.
 *
 * This handler only ever runs AFTER the OAuthProvider library has validated
 * the bearer token on an `/mcp` request — no token check happens here.
 *
 * Responsibilities (and nothing more):
 * - forward method/body and a small allowlist of relevant headers to
 *   `${ORIGIN_URL}/mcp` (path and query of the incoming request preserved);
 * - attach the `x-origin-secret` shared secret so the origin will answer at
 *   all (without it the origin replies 404);
 * - stream the origin's response back unchanged.
 *
 * It deliberately never forwards cookies or the client's Authorization
 * header: the bearer token authenticates the client to THIS worker only, and
 * the origin trusts the tunnel + shared secret, not tokens. Headers are
 * forwarded by allowlist (not blocklist) so nothing sensitive can leak
 * through by omission.
 */
import type { Env } from './index';

/**
 * Request headers forwarded to the origin. Everything MCP streamable-HTTP
 * needs and nothing else:
 * - `accept`, `accept-encoding`, `content-type` — content negotiation
 *   (JSON vs. SSE streams).
 * - `mcp-session-id`, `mcp-protocol-version` — MCP session headers.
 * - `last-event-id` — SSE stream resumption.
 *
 * Notably absent on purpose: `authorization`, `cookie`, and any `cf-*` /
 * `x-forwarded-*` metadata.
 */
const FORWARDED_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
] as const;

export const apiHandler = {
  async fetch(request, env): Promise<Response> {
    // Rebuild the target URL against the origin: same path + query, origin
    // host. ORIGIN_URL must be an origin without a path (e.g. the tunnel
    // hostname), so `/mcp` here maps to `${ORIGIN_URL}/mcp` as specified.
    let target: URL;
    try {
      const incoming = new URL(request.url);
      target = new URL(incoming.pathname + incoming.search, env.ORIGIN_URL);
    } catch (error) {
      // Misconfiguration (bad ORIGIN_URL). Log detail, answer generic.
      console.error('proxy: invalid ORIGIN_URL configuration', error);
      return new Response('Bad gateway', { status: 502 });
    }

    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) {
        headers.set(name, value);
      }
    }
    // The shared secret is the only thing the origin authenticates.
    headers.set('x-origin-secret', env.ORIGIN_SECRET);

    const init: RequestInit = {
      method: request.method,
      headers,
      // The origin is a direct upstream; a redirect from it would be
      // unexpected — pass it through rather than following it.
      redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // Stream the request body straight through (no buffering).
      init.body = request.body;
    }

    let upstream: Response;
    try {
      upstream = await fetch(target.toString(), init);
    } catch (error) {
      // Tunnel down / origin unreachable. Log detail, answer generic.
      console.error('proxy: origin fetch failed', error);
      return new Response('Bad gateway', { status: 502 });
    }

    // Stream the response back. Headers are copied so we can strip anything
    // cookie-shaped — the origin never sets cookies, but the edge must not
    // relay one even if it appeared.
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.delete('set-cookie');
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    });
  },
} satisfies ExportedHandler<Env>;
