/**
 * Authorize flow (default handler): consent UI + the two security cores of
 * this Worker.
 *
 * 1. redirect_uri allowlist — dynamic client registration (`/register`) is
 *    open by specification, so an attacker can register a client whose
 *    `redirect_uris` point at a domain they control and lure the owner into
 *    authorizing on the legitimate domain. The library only validates the
 *    redirect_uri against the CLIENT'S OWN registration, which the attacker
 *    wrote. This handler therefore rejects any `redirect_uri` that is not
 *    EXACTLY listed in the REDIRECT_ALLOWLIST var. Single-user system:
 *    fixing the list closes the rogue-client class entirely.
 *
 * 2. Consent attempt limiting — the consent password is the last gate before
 *    a grant. Every POST to /authorize counts against a per-IP budget stored
 *    in KV (`consent-attempts:<ip>`, max 5 per 15 minutes); over budget
 *    means 429 before any password comparison happens. A successful consent
 *    clears the counter.
 *
 * Password verification compares SHA-256 digests computed via
 * `crypto.subtle` — hashing both sides first makes the comparison
 * constant-time by construction (fixed-length digests, and the byte-wise
 * XOR accumulate below never exits early).
 *
 * Failures answer with minimal information; details go to console (Workers
 * logs), never into the response.
 */
import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import type { Env } from './index';

/** Single-user system: every grant belongs to the owner. */
const OWNER_USER_ID = 'owner';

/** Attempt limiting: max attempts per window, per IP. */
const MAX_ATTEMPTS = 5;
/** Attempt window in seconds (15 minutes), enforced through the KV TTL. */
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
const ATTEMPT_KEY_PREFIX = 'consent-attempts:';

export const defaultHandler = {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/authorize') {
      if (request.method === 'GET') {
        return handleConsentForm(request, env);
      }
      if (request.method === 'POST') {
        return handleConsentSubmit(request, env);
      }
      return minimalResponse(405, 'Method not allowed');
    }

    // Anything else that is neither an API route nor a library-implemented
    // endpoint: nothing to see.
    return minimalResponse(404, 'Not found');
  },
} satisfies ExportedHandler<Env>;

/** GET /authorize — render the consent page. */
async function handleConsentForm(request: Request, env: Env): Promise<Response> {
  const parsed = await parseAndCheckAuthRequest(request, env);
  if (parsed instanceof Response) {
    return parsed;
  }
  return consentPage({
    search: new URL(request.url).search,
    authRequest: parsed.authRequest,
    client: parsed.client,
  });
}

/** POST /authorize — enforce attempt limit, verify password, grant. */
async function handleConsentSubmit(request: Request, env: Env): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';

  // Attempt limiting comes FIRST: over-budget IPs get a 429 before any
  // parsing or password work happens.
  const existing = await readAttemptRecord(env, ip);
  if ((existing?.count ?? 0) >= MAX_ATTEMPTS) {
    console.warn(`consent: attempt limit reached for ${ip}`);
    return minimalResponse(429, 'Too many attempts', {
      'retry-after': String(ATTEMPT_WINDOW_SECONDS),
    });
  }
  // Every POST consumes an attempt, whatever happens next. A successful
  // consent clears the counter below. (KV is not transactional; a burst of
  // parallel requests can slightly overshoot the budget — acceptable for a
  // single-user system, and Cloudflare-level rate limiting sits in front.)
  await recordAttempt(env, ip, existing);

  const parsed = await parseAndCheckAuthRequest(request, env);
  if (parsed instanceof Response) {
    return parsed;
  }
  const { authRequest, client } = parsed;

  let password: string | null = null;
  try {
    const form = await request.formData();
    const value = form.get('password');
    if (typeof value === 'string') {
      password = value;
    }
  } catch {
    return minimalResponse(400, 'Invalid request');
  }

  const ok =
    password !== null && (await passwordMatches(password, env.CONSENT_PASSWORD));
  if (!ok) {
    console.warn(
      `consent: failed attempt from ${ip} (client ${authRequest.clientId})`,
    );
    // Generic message only — no hint about what was wrong.
    return consentPage({
      search: new URL(request.url).search,
      authRequest,
      client,
      errorMessage: 'Invalid credentials.',
      status: 401,
    });
  }

  await clearAttempts(env, ip);

  // The library stores the grant (hashes + encrypted props only) and hands
  // back the client's redirect_uri with code/state attached. `metadata` and
  // `props` are required by the library's API; this Worker's api handler
  // does not consume props (single-user proxy), so they stay minimal.
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authRequest,
    userId: OWNER_USER_ID,
    metadata: { authorizedAt: new Date().toISOString() },
    scope: authRequest.scope,
    props: { userId: OWNER_USER_ID },
  });

  return Response.redirect(redirectTo, 302);
}

/**
 * Parse the OAuth request via the library and run the checks shared by GET
 * and POST. Returns an error Response, or the parsed request + client info.
 *
 * Note: `parseAuthRequest()` reads the OAuth parameters from the QUERY
 * STRING only (also on POST) — which is why the consent form posts back to
 * `/authorize` with the original query string preserved. The library already
 * validates the redirect_uri against the client's registered list; the
 * allowlist check below is the additional, decisive layer (see file header).
 */
async function parseAndCheckAuthRequest(
  request: Request,
  env: Env,
): Promise<Response | { authRequest: AuthRequest; client: ClientInfo }> {
  let authRequest: AuthRequest;
  try {
    authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    console.warn('authorize: malformed authorization request', error);
    return minimalResponse(400, 'Invalid request');
  }

  if (authRequest.clientId === '' || authRequest.redirectUri === '') {
    console.warn('authorize: missing client_id or redirect_uri');
    return minimalResponse(400, 'Invalid request');
  }

  // SECURITY CORE: exact-match allowlist. Runs on GET (so the owner never
  // even sees a consent page for a rogue client) AND on POST (so the grant
  // path cannot be reached without it).
  if (!isRedirectUriAllowed(authRequest.redirectUri, env.REDIRECT_ALLOWLIST)) {
    console.warn(
      `authorize: redirect_uri rejected by allowlist: ${authRequest.redirectUri} (client ${authRequest.clientId})`,
    );
    return minimalResponse(403, 'Forbidden');
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(authRequest.clientId);
  if (client === null) {
    // parseAuthRequest already rejects unknown clients; belt and braces for
    // a client expiring between parse and lookup.
    console.warn(`authorize: unknown client ${authRequest.clientId}`);
    return minimalResponse(400, 'Invalid request');
  }

  return { authRequest, client };
}

/**
 * Exact string membership in the comma-separated REDIRECT_ALLOWLIST.
 * No prefix matching, no origin matching, no normalization beyond trimming
 * the configured entries: `https://claude.ai/api/mcp/auth_callback` matches
 * only that exact string.
 */
export function isRedirectUriAllowed(
  redirectUri: string,
  allowlist: string,
): boolean {
  const allowed = allowlist
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return allowed.includes(redirectUri);
}

/**
 * Constant-time password comparison: SHA-256 both sides via `crypto.subtle`,
 * then XOR-accumulate over the fixed-length digests. Hashing first removes
 * any length signal; the loop has no data-dependent branches.
 */
async function passwordMatches(
  supplied: string,
  expected: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(supplied)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(suppliedDigest);
  const b = new Uint8Array(expectedDigest);
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// ---------------------------------------------------------------------------
// Attempt limiting (KV)
// ---------------------------------------------------------------------------

interface AttemptRecord {
  count: number;
  /** Unix ms timestamp of the first attempt in the current window. */
  firstAttemptAt: number;
}

function attemptKey(ip: string): string {
  return `${ATTEMPT_KEY_PREFIX}${ip}`;
}

/**
 * Read the current attempt record for an IP. Records older than the window
 * are treated as absent (KV TTL should have removed them already; this
 * covers TTL deletion lag).
 */
async function readAttemptRecord(
  env: Env,
  ip: string,
): Promise<AttemptRecord | null> {
  const record = await env.OAUTH_KV.get<AttemptRecord>(attemptKey(ip), 'json');
  if (record === null) {
    return null;
  }
  if (Date.now() - record.firstAttemptAt >= ATTEMPT_WINDOW_SECONDS * 1000) {
    return null;
  }
  return record;
}

/**
 * Count one attempt. The KV entry expires with the REMAINDER of the fixed
 * 15-minute window (not a fresh 15 minutes per attempt), so the budget is
 * "5 per 15 min" exactly as specified. KV's minimum TTL is 60s, hence the
 * clamp.
 */
async function recordAttempt(
  env: Env,
  ip: string,
  existing: AttemptRecord | null,
): Promise<void> {
  const now = Date.now();
  const firstAttemptAt = existing?.firstAttemptAt ?? now;
  const record: AttemptRecord = {
    count: (existing?.count ?? 0) + 1,
    firstAttemptAt,
  };
  const remaining =
    ATTEMPT_WINDOW_SECONDS - Math.floor((now - firstAttemptAt) / 1000);
  await env.OAUTH_KV.put(attemptKey(ip), JSON.stringify(record), {
    expirationTtl: Math.max(60, remaining),
  });
}

async function clearAttempts(env: Env, ip: string): Promise<void> {
  await env.OAUTH_KV.delete(attemptKey(ip));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

interface ConsentPageOptions {
  /** Original query string (starts with '?'); carried into the form action. */
  search: string;
  authRequest: AuthRequest;
  client: ClientInfo;
  errorMessage?: string;
  status?: number;
}

/**
 * Minimal, fully self-contained consent page: inline CSS only, no scripts,
 * no external assets. All client-supplied strings (names, URIs, scopes) are
 * HTML-escaped — client metadata is attacker-controlled input.
 */
function consentPage(options: ConsentPageOptions): Response {
  const clientName = options.client.clientName ?? options.client.clientId;
  const scopes = options.authRequest.scope;
  const scopesHtml =
    scopes.length > 0
      ? `<ul>${scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>`
      : '<p class="muted">No specific scopes requested.</p>';
  const errorHtml =
    options.errorMessage !== undefined
      ? `<p class="error" role="alert">${escapeHtml(options.errorMessage)}</p>`
      : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Authorize access</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; margin: 0; display: flex; justify-content: center; padding: 3rem 1rem; }
  main { max-width: 26rem; width: 100%; }
  h1 { font-size: 1.25rem; }
  dl { border: 1px solid color-mix(in srgb, currentColor 25%, transparent); border-radius: 0.5rem; padding: 0.75rem 1rem; }
  dt { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.7; margin-top: 0.5rem; }
  dt:first-child { margin-top: 0; }
  dd { margin: 0.1rem 0 0 0; overflow-wrap: anywhere; }
  dd ul { margin: 0.25rem 0 0 0; padding-left: 1.1rem; }
  .muted { opacity: 0.7; margin: 0.25rem 0 0 0; }
  .error { color: #b3261e; font-weight: 600; }
  form { margin-top: 1.25rem; }
  label { display: block; font-weight: 600; margin-bottom: 0.35rem; }
  input[type="password"] { width: 100%; box-sizing: border-box; padding: 0.5rem 0.6rem; font-size: 1rem; border: 1px solid color-mix(in srgb, currentColor 35%, transparent); border-radius: 0.35rem; background: transparent; color: inherit; }
  button { margin-top: 0.9rem; width: 100%; padding: 0.6rem; font-size: 1rem; font-weight: 600; border: none; border-radius: 0.35rem; cursor: pointer; background: #3b5bdb; color: #fff; }
  .note { font-size: 0.85rem; opacity: 0.75; margin-top: 1.25rem; }
</style>
</head>
<body>
<main>
  <h1>Authorize access</h1>
  <p><strong>${escapeHtml(clientName)}</strong> is asking to connect to your vault through this MCP server.</p>
  <dl>
    <dt>Client ID</dt>
    <dd><code>${escapeHtml(options.authRequest.clientId)}</code></dd>
    <dt>Redirects to</dt>
    <dd><code>${escapeHtml(options.authRequest.redirectUri)}</code></dd>
    <dt>Requested scopes</dt>
    <dd>${scopesHtml}</dd>
  </dl>
  ${errorHtml}
  <form method="post" action="/authorize${escapeHtml(options.search)}">
    <label for="password">Consent password</label>
    <input type="password" id="password" name="password" required autocomplete="current-password" autofocus>
    <button type="submit">Approve</button>
  </form>
  <p class="note">Approving lets this client read and write notes in your vault. If you did not initiate this, close this page.</p>
</main>
</body>
</html>
`;

  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The consent page must never be framed (clickjacking) and never
      // load or send anything anywhere ('self' form post only).
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
    },
  });
}

/** Minimal-information plain-text error response. */
function minimalResponse(
  status: number,
  body: string,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
