/**
 * @vault-mcp/guards — sanitization and warn-only heuristics for vault
 * content. Pure functions, zero dependencies, no I/O.
 *
 * Threat model (ARCHITECTURE.md §5.3): vault content is untrusted input;
 * the dominant threat is prompt injection invisible to the human but
 * readable by the model. The defense is channel closure, not detection.
 */

export type { SanitizationReport, SanitizedContent } from './invisible.js';
export type { ReadSanitizeOptions } from './sanitize-read.js';
export { sanitizeForModel } from './sanitize-read.js';
export type {
  SanitizedWriteContent,
  WriteSanitizationReport,
  WriteSanitizeOptions,
} from './sanitize-write.js';
export { sanitizeForWrite } from './sanitize-write.js';
export { detectSuspiciousContent } from './heuristics.js';
