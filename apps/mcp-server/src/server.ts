import { Buffer } from 'node:buffer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  VaultError,
  appendToNote,
  appendToSection,
  completeTask,
  createDailyNote,
  createNote,
  deleteNote,
  editNote,
  getDailyNote,
  getVaultTree,
  listRecent,
  listTasks,
  moveNote,
  postponeTask,
  readNote,
  searchNotes,
  type NoteContent,
  type NoteEdit,
  type TaskItem,
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
  appendToSection as appendSectionContract,
  completeTask as completeTaskContract,
  createDailyNote as createDailyContract,
  createNote as createContract,
  deleteNote as deleteContract,
  editNote as editContract,
  getDailyNote as dailyContract,
  getVaultTree as treeContract,
  listRecent as recentContract,
  listTasks as listTasksContract,
  moveNote as moveContract,
  postponeTask as postponeTaskContract,
  readNote as readContract,
  readNotes as readNotesContract,
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
  // The header carries the note's version hash so any later edit can pass it
  // back as expected_hash; without it, concurrent edits are silently clobbered.
  const header = `[${cleanPath(note.path).path} | ${note.sizeBytes} bytes | version ${note.hash}]`;
  const body = renderRead(note.content);
  if (!note.truncated) return `${header}\n${body}`;
  const shown = Buffer.byteLength(note.content);
  return `${header}\n[truncated: showing ${shown} of ${note.sizeBytes} bytes]\n${body}`;
}

function renderTask(task: TaskItem): string {
  const box = task.done ? '[x]' : '[ ]';
  const parts = [`${box} ${task.text}`];
  if (task.due !== undefined) parts.push(`due ${task.due}`);
  if (task.scheduled !== undefined) parts.push(`scheduled ${task.scheduled}`);
  if (task.start !== undefined) parts.push(`start ${task.start}`);
  if (task.doneDate !== undefined) parts.push(`done ${task.doneDate}`);
  if (task.priority !== undefined) parts.push(`priority ${task.priority}`);
  if (task.recurrence !== undefined) parts.push(`repeats ${task.recurrence}`);
  parts.push(`at ${cleanPath(task.path).path}:${task.line}`, `version ${task.hash}`);
  return parts.join(' | ');
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

  register<{
    query: string;
    limit: number;
    offset: number;
    path_prefix?: string;
    sort_by: 'path' | 'mtime';
    tag?: string;
    include_low_trust: boolean;
  }>(
    searchContract,
    async ({ query, limit, offset, path_prefix, sort_by, tag, include_low_trust }) => {
      const result = await searchNotes(vault, query, {
        limit,
        offset,
        includeLowTrust: include_low_trust,
        ...(path_prefix !== undefined ? { pathPrefix: path_prefix } : {}),
        sortBy: sort_by,
        ...(tag !== undefined ? { tag } : {}),
      });
      const matches = result.matches;
      if (matches.length === 0) {
        const hint =
          !include_low_trust && vault.lowTrustFolders.length > 0
            ? ' Imported/low-trust folders were excluded; retry with include_low_trust if the user asks about clipped material.'
            : '';
        const paging =
          offset > 0 ? ` (offset ${offset} is past the last match)` : '';
        return { text: `0 matches for "${query}"${paging}.${hint}` };
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
      const heading =
        `${matches.length} matches for "${query}"` +
        (offset > 0 ? ` (offset ${offset})` : '');
      const paging = result.hasMore
        ? [`More matches exist: call search_notes again with offset=${offset + limit}.`]
        : [];
      return {
        text: [heading, ...lines, ...report, ...warnings, ...paging].join('\n'),
      };
    },
  );

  register<{ path: string }>(readContract, async ({ path }) => {
    const note = await readNote(vault, path);
    return { text: renderNote(note), path: note.path };
  });

  register<{ paths: string[] }>(readNotesContract, async ({ paths }) => {
    const sections: string[] = [];
    for (const p of paths) {
      try {
        const note = await readNote(vault, p);
        sections.push(renderNote(note));
      } catch (err) {
        if (err instanceof VaultError) {
          sections.push(`[${cleanPath(p).path}] ${err.code}: ${scrub(err.message, vault)}`);
        } else {
          throw err;
        }
      }
    }
    return { text: sections.join('\n\n---\n\n') };
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

  register<Record<string, never>>(treeContract, async () => {
    const folders = await getVaultTree(vault);
    if (folders.length === 0) return { text: 'The vault has no markdown notes yet.' };
    let alteredNames = 0;
    const lines = folders.map((f) => {
      const where = cleanPath(f.path);
      if (where.altered) alteredNames += 1;
      const label = where.path === '' ? '(vault root)' : `${where.path}/`;
      return `${label} — ${f.noteCount} ${plural(f.noteCount, 'note')}`;
    });
    if (alteredNames > 0) {
      lines.push(
        `[sanitizer] removed: invisible characters in ${alteredNames} folder ` +
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
          'Use create_daily_note to create it with the daily-notes template applied.',
      };
    }
    return { text: renderNote(info.note), path: info.path };
  });

  register<{ date?: string }>(createDailyContract, async ({ date }) => {
    const result = await createDailyNote(vault, date);
    if (!result.created) {
      return {
        path: result.path,
        text:
          `Daily note for ${result.date} already exists at ${cleanPath(result.path).path}; ` +
          'nothing was written. Read it with get_daily_note.',
      };
    }
    const templateNote = result.templateApplied
      ? 'the daily-notes template was applied'
      : 'no daily-notes template is configured (or it was unreadable), so the note is empty';
    return {
      path: result.path,
      text: `Created ${cleanPath(result.path).path} for ${result.date} — ${templateNote}.`,
    };
  });

  register<{ path: string; content: string }>(
    createContract,
    async ({ path, content }) => {
      const sanitized = sanitizeForWrite(content);
      if (sanitized.report.blocked.length > 0) {
        return refuseUnsafeWrite(sanitized.report.blocked);
      }
      const result = await createNote(vault, path, sanitized.content);
      const lines = [`Created ${result.path} (version ${result.hash})`];
      if (sanitized.report.removed.length > 0) {
        lines.push(`[sanitizer] ${sanitized.report.removed.join('; ')}`);
      }
      return { text: lines.join('\n'), path: result.path };
    },
  );

  register<{ path: string; content: string; expected_hash?: string }>(
    appendContract,
    async ({ path, content, expected_hash }) => {
      const sanitized = sanitizeForWrite(content);
      if (sanitized.report.blocked.length > 0) {
        return refuseUnsafeWrite(sanitized.report.blocked);
      }
      const result = await appendToNote(vault, path, sanitized.content, {
        ...(expected_hash !== undefined ? { expectedHash: expected_hash } : {}),
      });
      const lines = [
        `Appended to ${result.path} (now ${result.sizeBytes} bytes, version ${result.hash})`,
      ];
      if (sanitized.report.removed.length > 0) {
        lines.push(`[sanitizer] ${sanitized.report.removed.join('; ')}`);
      }
      return { text: lines.join('\n'), path: result.path };
    },
  );

  register<{ path: string; heading: string; content: string; expected_hash?: string }>(
    appendSectionContract,
    async ({ path, heading, content, expected_hash }) => {
      const sanitized = sanitizeForWrite(content);
      if (sanitized.report.blocked.length > 0) {
        return refuseUnsafeWrite(sanitized.report.blocked);
      }
      const result = await appendToSection(vault, path, heading, sanitized.content, {
        ...(expected_hash !== undefined ? { expectedHash: expected_hash } : {}),
      });
      const lines = [
        `Inserted into "${heading}" of ${result.path} at line ${result.insertedAtLine} ` +
          `(now ${result.sizeBytes} bytes, version ${result.hash})`,
      ];
      if (sanitized.report.removed.length > 0) {
        lines.push(`[sanitizer] ${sanitized.report.removed.join('; ')}`);
      }
      return { text: lines.join('\n'), path: result.path };
    },
  );

  register<{
    path: string;
    edits: Array<{ old_string: string; new_string: string }>;
    expected_hash?: string;
  }>(editContract, async ({ path, edits, expected_hash }) => {
    const prepared: NoteEdit[] = [];
    const removed: string[] = [];
    for (const edit of edits) {
      // Only the replacement text is new content entering the vault; the old
      // string just has to match what is already there.
      const sanitized = sanitizeForWrite(edit.new_string);
      if (sanitized.report.blocked.length > 0) {
        return refuseUnsafeWrite(sanitized.report.blocked);
      }
      for (const reason of sanitized.report.removed) {
        if (!removed.includes(reason)) removed.push(reason);
      }
      prepared.push({ oldString: edit.old_string, newString: sanitized.content });
    }
    const result = await editNote(vault, path, prepared, {
      ...(expected_hash !== undefined ? { expectedHash: expected_hash } : {}),
    });
    const lines = [
      `Applied ${result.editsApplied} ${plural(result.editsApplied, 'edit')} to ` +
        `${result.path} (now ${result.sizeBytes} bytes, version ${result.hash})`,
    ];
    if (removed.length > 0) {
      lines.push(`[sanitizer] ${removed.join('; ')}`);
    }
    return { text: lines.join('\n'), path: result.path };
  });

  register<{ from: string; to: string }>(moveContract, async ({ from, to }) => {
    const result = await moveNote(vault, from, to);
    return {
      text:
        `Moved ${result.from} → ${result.to}. Wiki-links pointing at the old ` +
        'name were NOT rewritten.',
      path: result.to,
    };
  });

  register<{ path: string }>(deleteContract, async ({ path }) => {
    const result = await deleteNote(vault, path);
    return {
      text:
        `Moved ${result.path} to the vault trash (${result.trashedTo}). ` +
        'It can be restored from Obsidian.',
      path: result.path,
    };
  });

  register<{
    status: 'open' | 'done' | 'all';
    due_before?: string;
    due_after?: string;
    path_prefix?: string;
    limit: number;
    offset: number;
  }>(listTasksContract, async ({ status, due_before, due_after, path_prefix, limit, offset }) => {
    const result = await listTasks(vault, {
      status,
      ...(due_before !== undefined ? { dueBefore: due_before } : {}),
      ...(due_after !== undefined ? { dueAfter: due_after } : {}),
      ...(path_prefix !== undefined ? { pathPrefix: path_prefix } : {}),
      limit,
      offset,
    });
    if (result.tasks.length === 0) {
      return { text: `0 ${status} tasks match the given filters.` };
    }
    // Task text is vault content: sanitize the rendered block like any read.
    const block = result.tasks.map(renderTask).join('\n');
    const sanitized = sanitizeForModel(block);
    const lines = [
      `${result.tasks.length} ${plural(result.tasks.length, 'task')} (status: ${status})` +
        (offset > 0 ? ` (offset ${offset})` : ''),
      sanitized.content,
    ];
    if (sanitized.report.removed.length > 0) {
      lines.push(`[sanitizer] removed: ${sanitized.report.removed.join('; ')}`);
    }
    for (const warning of detectSuspiciousContent(sanitized.content)) {
      lines.push(`[warning] ${warning}`);
    }
    if (result.hasMore) {
      lines.push(`More tasks exist: call list_tasks again with offset=${offset + limit}.`);
    }
    return { text: lines.join('\n') };
  });

  register<{ path: string; line: number; done_date?: string; expected_hash?: string }>(
    completeTaskContract,
    async ({ path, line, done_date, expected_hash }) => {
      const result = await completeTask(vault, path, line, done_date, {
        ...(expected_hash !== undefined ? { expectedHash: expected_hash } : {}),
      });
      const shownLine = sanitizeForModel(result.taskLine).content;
      if (result.alreadyDone) {
        return {
          path: result.path,
          text: `Task at ${result.path}:${result.line} was already done: ${shownLine}`,
        };
      }
      const lines = [
        `Completed task at ${result.path}:${result.line} (version ${result.hash}): ${shownLine}`,
      ];
      if (result.recurrence !== undefined) {
        lines.push(
          `Note: this task repeats (${sanitizeForModel(result.recurrence).content}); ` +
            'the next occurrence was NOT generated — tell the user.',
        );
      }
      return { text: lines.join('\n'), path: result.path };
    },
  );

  register<{ path: string; line: number; new_date: string; expected_hash?: string }>(
    postponeTaskContract,
    async ({ path, line, new_date, expected_hash }) => {
      const result = await postponeTask(vault, path, line, new_date, {
        ...(expected_hash !== undefined ? { expectedHash: expected_hash } : {}),
      });
      const shownLine = sanitizeForModel(result.taskLine).content;
      const fromNote =
        result.previousDue !== undefined
          ? `due date changed ${result.previousDue} → ${new_date}`
          : `due date set to ${new_date}`;
      return {
        text: `Updated task at ${result.path}:${result.line} (${fromNote}, version ${result.hash}): ${shownLine}`,
        path: result.path,
      };
    },
  );

  return server;
}
