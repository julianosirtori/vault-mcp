import { Buffer } from 'node:buffer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  VaultError,
  appendToNote,
  createNote,
  getDailyNote,
  listRecent,
  readNote,
  searchNotes,
  type NoteContent,
  type Vault,
} from '@vault-mcp/core';
import {
  detectSuspiciousContent,
  sanitizeForModel,
  sanitizeForWrite,
} from '@vault-mcp/guards';
import {
  CONTRACT_VERSION,
  appendToNote as appendContract,
  createNote as createContract,
  getDailyNote as dailyContract,
  listRecent as recentContract,
  readNote as readContract,
  searchNotes as searchContract,
} from '@vault-mcp/tool-contract';
import { auditLog } from './audit.js';

interface ToolOutcome {
  text: string;
  isError?: boolean;
  /** Vault-relative path touched, for the audit log. */
  path?: string;
  errorCode?: string;
}

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Errors sent to the model never contain absolute paths or stack traces. */
function scrub(message: string, vault: Vault): string {
  return message.split(vault.root).join('<vault>');
}

function toResult(outcome: ToolOutcome): ToolResult {
  return {
    content: [{ type: 'text', text: outcome.text }],
    ...(outcome.isError ? { isError: true } : {}),
  };
}

/**
 * Note *names* are model-facing content too: a file name can carry invisible
 * instructions (Unicode tag block, zero-width/bidi controls) or a newline that
 * forges an extra result line, and neither ever passes through the content
 * sanitizer. vault-core refuses to create such paths, but names that arrived
 * through sync or a shell still show up in search and list_recent, so they are
 * stripped on the way out (ARCHITECTURE.md §5.3: channel closure).
 *
 * Table mirrors packages/vault-guards/src/invisible.ts (source of truth) plus
 * C0/C1 controls; packages/vault-core/src/paths.ts rejects the same set.
 */
const INVISIBLE_PATH_CHAR_RE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u001F\u007F-\u009F\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u{E0000}-\u{E007F}]/gu;

/** Strip invisible characters from a vault-relative path bound for the model. */
function cleanPath(relPath: string): { path: string; altered: boolean } {
  const cleaned = relPath.replace(INVISIBLE_PATH_CHAR_RE, '');
  return { path: cleaned, altered: cleaned !== relPath };
}

function plural(n: number, singular: string): string {
  return n === 1 ? singular : `${singular}s`;
}

/**
 * Sanitize content read from the vault before it reaches the model, and be
 * transparent about it: the owner must be able to tell content was altered,
 * and warnings are warn-only by design — never blocking.
 */
function renderRead(content: string): string {
  const sanitized = sanitizeForModel(content);
  const lines = [sanitized.content];
  if (sanitized.report.removed.length > 0) {
    lines.push('', `[sanitizer] removed: ${sanitized.report.removed.join('; ')}`);
  }
  for (const warning of detectSuspiciousContent(sanitized.content)) {
    lines.push(`[warning] ${warning}`);
  }
  return lines.join('\n');
}

/**
 * A non-empty `blocked` list means the write sanitizer could not neutralize
 * the content (ARCHITECTURE.md §5.3 item 2). Writing it anyway would put a
 * live remote-fetch vector in the vault, so the tool call fails instead.
 */
function refuseUnsafeWrite(blocked: string[]): ToolOutcome {
  return {
    text:
      `UNSAFE_CONTENT: refused the write — the sanitizer could not neutralize: ${blocked.join('; ')}. ` +
      'Rewrite the content without remote embeds or raw HTML.',
    isError: true,
    errorCode: 'UNSAFE_CONTENT',
  };
}

function renderNote(note: NoteContent): string {
  const body = renderRead(note.content);
  if (!note.truncated) return body;
  const shown = Buffer.byteLength(note.content);
  return `[truncated: showing ${shown} of ${note.sizeBytes} bytes]\n${body}`;
}

export function buildServer(vault: Vault): McpServer {
  const server = new McpServer({ name: 'vault-mcp', version: CONTRACT_VERSION });

  function register<Args>(
    contract: {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: Record<string, unknown>;
    },
    handler: (args: Args) => Promise<ToolOutcome>,
  ): void {
    server.registerTool(
      contract.name,
      {
        title: contract.title,
        description: contract.description,
        // The contract owns the zod shapes; the SDK validates against them.
        inputSchema: contract.inputSchema as never,
        annotations: contract.annotations,
      },
      (async (args: Args): Promise<ToolResult> => {
        const started = performance.now();
        let outcome: ToolOutcome;
        try {
          outcome = await handler(args);
        } catch (err) {
          if (err instanceof VaultError) {
            outcome = {
              text: `${err.code}: ${scrub(err.message, vault)}`,
              isError: true,
              errorCode: err.code,
            };
          } else {
            // Full detail goes to stderr for the operator, never to the model.
            console.error(`[vault-mcp] ${contract.name} failed:`, err);
            outcome = {
              text: `INTERNAL: the ${contract.name} tool failed unexpectedly`,
              isError: true,
              errorCode: 'INTERNAL',
            };
          }
        }
        auditLog({
          ts: new Date().toISOString(),
          tool: contract.name,
          ...(outcome.path ? { path: outcome.path } : {}),
          ok: !outcome.isError,
          bytes: Buffer.byteLength(outcome.text),
          ms: Math.round(performance.now() - started),
          ...(outcome.errorCode ? { error: outcome.errorCode } : {}),
        });
        return toResult(outcome);
      }) as never,
    );
  }

  register<{ query: string; limit: number; include_low_trust: boolean }>(
    searchContract,
    async ({ query, limit, include_low_trust }) => {
      const matches = await searchNotes(vault, query, {
        limit,
        includeLowTrust: include_low_trust,
      });
      if (matches.length === 0) {
        const hint =
          !include_low_trust && vault.lowTrustFolders.length > 0
            ? ' Imported/low-trust folders were excluded; retry with include_low_trust if the user asks about clipped material.'
            : '';
        return { text: `0 matches for "${query}".${hint}` };
      }
      // Snippets are read results too: they get sanitized, and — like
      // read_note — the owner is told when quoted text differs from disk.
      const reasons: string[] = [];
      let alteredSnippets = 0;
      let alteredNames = 0;
      const lines = matches.map((m) => {
        const sanitized = sanitizeForModel(m.snippet);
        if (sanitized.report.removed.length > 0) {
          alteredSnippets += 1;
          for (const reason of sanitized.report.removed) {
            if (!reasons.includes(reason)) reasons.push(reason);
          }
        }
        const where = cleanPath(m.path);
        if (where.altered) alteredNames += 1;
        return `${where.path}:${m.line}: ${sanitized.content}`;
      });
      const disclosures: string[] = [];
      if (reasons.length > 0) {
        disclosures.push(
          `${reasons.join('; ')} (in ${alteredSnippets} of ${matches.length} snippets)`,
        );
      }
      if (alteredNames > 0) {
        disclosures.push(
          `invisible characters in ${alteredNames} note ${plural(alteredNames, 'name')}`,
        );
      }
      const report =
        disclosures.length > 0 ? [`[sanitizer] removed: ${disclosures.join('; ')}`] : [];
      const warnings = detectSuspiciousContent(lines.join('\n')).map(
        (w) => `[warning] ${w}`,
      );
      return {
        text: [
          `${matches.length} matches for "${query}"`,
          ...lines,
          ...report,
          ...warnings,
        ].join('\n'),
      };
    },
  );

  register<{ path: string }>(readContract, async ({ path }) => {
    const note = await readNote(vault, path);
    return { text: renderNote(note), path: note.path };
  });

  register<{ limit: number }>(recentContract, async ({ limit }) => {
    const notes = await listRecent(vault, { limit });
    if (notes.length === 0) return { text: 'The vault has no markdown notes yet.' };
    let alteredNames = 0;
    const lines = notes.map((n) => {
      const where = cleanPath(n.path);
      if (where.altered) alteredNames += 1;
      return `${where.path} — ${n.modifiedAt}`;
    });
    if (alteredNames > 0) {
      lines.push(
        `[sanitizer] removed: invisible characters in ${alteredNames} note ` +
          plural(alteredNames, 'name'),
      );
    }
    return { text: lines.join('\n') };
  });

  register<{ date?: string }>(dailyContract, async ({ date }) => {
    const info = await getDailyNote(vault, date);
    if (!info.exists || !info.note) {
      // info.date is the resolved day, so an omitted date still yields a
      // concrete YYYY-MM-DD — "today" would leave the model guessing.
      return {
        path: info.path,
        text:
          `Daily note for ${info.date} does not exist yet. It would be created at: ` +
          `${cleanPath(info.path).path}. ` +
          'Use create_note to create it (the daily-notes template will NOT be applied).',
      };
    }
    return { text: renderNote(info.note), path: info.path };
  });

  register<{ path: string; content: string }>(
    createContract,
    async ({ path, content }) => {
      const sanitized = sanitizeForWrite(content);
      if (sanitized.report.blocked.length > 0) {
        return refuseUnsafeWrite(sanitized.report.blocked);
      }
      const result = await createNote(vault, path, sanitized.content);
      const lines = [`Created ${result.path}`];
      if (sanitized.report.removed.length > 0) {
        lines.push(`[sanitizer] ${sanitized.report.removed.join('; ')}`);
      }
      return { text: lines.join('\n'), path: result.path };
    },
  );

  register<{ path: string; content: string }>(
    appendContract,
    async ({ path, content }) => {
      const sanitized = sanitizeForWrite(content);
      if (sanitized.report.blocked.length > 0) {
        return refuseUnsafeWrite(sanitized.report.blocked);
      }
      const result = await appendToNote(vault, path, sanitized.content);
      const lines = [`Appended to ${result.path} (now ${result.sizeBytes} bytes)`];
      if (sanitized.report.removed.length > 0) {
        lines.push(`[sanitizer] ${sanitized.report.removed.join('; ')}`);
      }
      return { text: lines.join('\n'), path: result.path };
    },
  );

  return server;
}
