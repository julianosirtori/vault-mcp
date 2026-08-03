export type {
  Vault,
  VaultOptions,
  NoteContent,
  SearchMatch,
  SearchOptions,
  RecentNote,
  DailyNoteInfo,
} from './types.js';
export { VaultError } from './errors.js';
export type { VaultErrorCode } from './errors.js';
export { openVault } from './vault.js';
export { resolveNotePath, toVaultRelative } from './paths.js';
export type { ResolveNoteOptions } from './paths.js';
export { readNote, createNote, appendToNote } from './io.js';
export { searchNotes } from './search.js';
export { listRecent } from './recent.js';
export type { ListRecentOptions } from './recent.js';
export { getDailyNote, formatDailyName } from './daily.js';
