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
  /**
   * Short content hash identifying this version of the note on disk. Pass it
   * back as expected_hash on a later write to detect stale edits. The core
   * revalidates immediately before replacement; unrelated filesystem writers
   * can still race the final atomic rename.
   */
  hash: string;
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
  /** Matches to skip before collecting, for pagination. Default 0. */
  offset?: number;
  /** Include matches from low-trust folders. Default false. */
  includeLowTrust?: boolean;
  /** Only search notes whose vault-relative path starts with this prefix. */
  pathPrefix?: string;
  /** File visit order: 'path' (lexicographic) or 'mtime' (newest first). */
  sortBy?: 'path' | 'mtime';
  /** Only search notes carrying this #tag (inline or frontmatter). */
  tag?: string;
}

export interface SearchResult {
  matches: SearchMatch[];
  /** True when more matches exist beyond offset+limit. */
  hasMore: boolean;
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

export interface CreateDailyResult {
  path: string;
  /** The resolved day as YYYY-MM-DD. */
  date: string;
  /** False when the note already existed (nothing was written). */
  created: boolean;
  /** True when the configured daily-notes template seeded the new note. */
  templateApplied: boolean;
}

/** One search-and-replace step of an edit. The old string must be unique. */
export interface NoteEdit {
  oldString: string;
  newString: string;
}

export interface WriteGuardOptions {
  /**
   * Hash from a previous read of this note. When set and the note on disk no
   * longer matches when checked, the write fails with CONFLICT instead of
   * clobbering a stale version. This is best-effort against unrelated external
   * writers because portable filesystems do not provide content-based CAS.
   */
  expectedHash?: string;
}

export type TaskPriority = 'highest' | 'high' | 'medium' | 'low' | 'lowest';

/** A checkbox task parsed from a note, Obsidian Tasks plugin conventions. */
export interface TaskItem {
  path: string;
  /** 1-based line number of the task in the note. */
  line: number;
  /** Version hash of the containing note, for expected_hash on task writes. */
  hash: string;
  /** Task description with status/date/priority signifiers stripped. */
  text: string;
  done: boolean;
  /** 📅 due date, YYYY-MM-DD. */
  due?: string;
  /** ⏳ scheduled date. */
  scheduled?: string;
  /** 🛫 start date. */
  start?: string;
  /** ✅ completion date. */
  doneDate?: string;
  priority?: TaskPriority;
  /** 🔁 recurrence rule text, when present. */
  recurrence?: string;
}

export interface ListTasksOptions {
  /** Which tasks to return. Default 'open'. */
  status?: 'open' | 'done' | 'all';
  /** Only tasks with a due date on or before this YYYY-MM-DD day. */
  dueBefore?: string;
  /** Only tasks with a due date on or after this YYYY-MM-DD day. */
  dueAfter?: string;
  /** Only tasks in notes under this vault-relative path prefix. */
  pathPrefix?: string;
  /** Max tasks returned. Default 50, cap 100. */
  limit?: number;
  /** Tasks to skip, for pagination. Default 0. */
  offset?: number;
  /** Include tasks from low-trust folders. Default false. */
  includeLowTrust?: boolean;
}

export interface ListTasksResult {
  tasks: TaskItem[];
  /** True when more tasks exist beyond offset+limit. */
  hasMore: boolean;
}

/** A folder in the vault tree, with the number of notes directly inside it. */
export interface VaultTreeFolder {
  /** Vault-relative folder path; '' is the vault root. */
  path: string;
  /** Markdown notes directly in this folder (not in subfolders). */
  noteCount: number;
}
