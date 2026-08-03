/**
 * Warn-only heuristics. NEVER blocks — trivially bypassable by design.
 *
 * ARCHITECTURE.md §5.3: keyword filters exist only to alert the owner, never
 * to enforce. They false-positive on the owner's own notes about prompt
 * injection, and that is fine: the owner reads the warning and moves on.
 */

/** Collapse whitespace and truncate a matched snippet for a warning line. */
function snippet(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const OVERRIDE_RE =
  /\b(?:ignore|disregard|forget)\s+(?:\w+\s+){0,4}?instructions\b/i;

const ROLE_REASSIGN_RE = /\byou\s+are\s+now\b|\bact\s+as\b/i;

const ADDRESS_MODEL_RE = /^[ \t]*(?:assistant|system)[ \t]*:/im;

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

/** Query-param name that typically carries exfiltrated data or credentials. */
const DATA_PARAM_NAME_RE = /(?:^|[_-])(?:data|token|key|secret)$/i;

/** Length past which a `?q=` value stops looking like a human search. */
const LONG_QUERY_VALUE = 25;

const BASE64_RUN_RE = /[A-Za-z0-9+/]{201,}={0,2}/;

/** Returns the first suspicious URL in the text, if any. */
function findSuspiciousUrl(text: string): string | undefined {
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    const url = m[0];
    const qIndex = url.indexOf('?');
    if (qIndex === -1) continue;
    const query = url.slice(qIndex + 1).replace(/#.*$/, '');
    for (const pair of query.split(/[&;]/)) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (DATA_PARAM_NAME_RE.test(name)) return url;
      if (/^q$/i.test(name) && value.length >= LONG_QUERY_VALUE) return url;
    }
  }
  return undefined;
}

/**
 * Scan content for signs of prompt injection or data smuggling and return
 * human-readable warnings — one per triggered rule, empty when clean.
 *
 * Warn-only: the caller must surface these to the owner, never block on them.
 */
export function detectSuspiciousContent(markdown: string): string[] {
  const warnings: string[] = [];

  const override = OVERRIDE_RE.exec(markdown);
  if (override) {
    warnings.push(
      `possible instruction-override phrase: "${snippet(override[0])}"`,
    );
  }

  const role = ROLE_REASSIGN_RE.exec(markdown);
  if (role) {
    warnings.push(
      `possible role-reassignment phrase: "${snippet(role[0])}"`,
    );
  }

  const address = ADDRESS_MODEL_RE.exec(markdown);
  if (address) {
    warnings.push(
      `line starts by addressing the model: "${snippet(address[0])}"`,
    );
  }

  const url = findSuspiciousUrl(markdown);
  if (url !== undefined) {
    warnings.push(
      `URL carries a data-bearing query parameter: "${snippet(url)}"`,
    );
  }

  const base64 = BASE64_RUN_RE.exec(markdown);
  if (base64) {
    warnings.push(
      `base64-like run of ${base64[0].length} characters (possible smuggled payload)`,
    );
  }

  return warnings;
}
