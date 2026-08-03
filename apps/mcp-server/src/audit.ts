export interface AuditEntry {
  ts: string;
  tool: string;
  path?: string;
  ok: boolean;
  /** Size in bytes of the content returned to the model. */
  bytes: number;
  ms: number;
  /** VaultError code or 'INTERNAL'. */
  error?: string;
}

/**
 * One JSON line per tool call, to stdout — journald captures it. This is the
 * complete audit trail: time, tool, path touched, size of the return.
 */
export function auditLog(
  entry: AuditEntry,
  out: NodeJS.WritableStream = process.stdout,
): void {
  out.write(`${JSON.stringify(entry)}\n`);
}
