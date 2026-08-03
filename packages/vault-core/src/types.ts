export interface VaultOptions {
  /** Absolute path to the vault root directory. Must exist. */
  root: string;
  /** Vault-relative folder prefixes holding imported/low-trust content. */
  lowTrustFolders?: string[];
  /** Max bytes returned by a single read before truncation. Default 200_000. */
  maxReadBytes?: number;
}

export interface Vault {
  /** Resolved (realpath) absolute vault root. */
  readonly root: string;
  readonly lowTrustFolders: readonly string[];
  readonly maxReadBytes: number;
}

export interface NoteContent {
  /** Vault-relative path, normalized with forward slashes. */
  path: string;
  content: string;
  truncated: boolean;
  /** Full size on disk in bytes (not the truncated size). */
  sizeBytes: number;
}

export interface SearchMatch {
  path: string;
  /** 1-based line number. */
  line: number;
  /** Trimmed line content, capped in length. */
  snippet: string;
}

export interface SearchOptions {
  /** Max matches returned. Default 20, cap 50. */
  limit?: number;
  /** Include matches from low-trust folders. Default false. */
  includeLowTrust?: boolean;
}

export interface RecentNote {
  path: string;
  /** ISO 8601 timestamp of last modification. */
  modifiedAt: string;
}

export interface DailyNoteInfo {
  /** Vault-relative path the daily note has (or would have). */
  path: string;
  /**
   * The resolved day as YYYY-MM-DD (server-local). Always concrete, even when
   * the caller passed no date or the configured format does not contain one
   * (e.g. `dddd` → `Monday.md`), so callers never have to say "today".
   */
  date: string;
  exists: boolean;
  /** Present only when exists is true. */
  note?: NoteContent;
}
