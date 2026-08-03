export type {
  Vault,
  VaultOptions,
  NoteContent,
  NoteEdit,
  WriteGuardOptions,
  SearchMatch,
  SearchOptions,
  SearchResult,
  RecentNote,
  DailyNoteInfo,
  CreateDailyResult,
  TaskItem,
  TaskPriority,
  ListTasksOptions,
  ListTasksResult,
  VaultTreeFolder,
} from './types.js';
export { VaultError } from './errors.js';
export type { VaultErrorCode } from './errors.js';
export { openVault } from './vault.js';
export { resolveNotePath, toVaultRelative } from './paths.js';
export type { ResolveNoteOptions } from './paths.js';
export {
  readNote,
  createNote,
  appendToNote,
  editNote,
  deleteNote,
  moveNote,
  contentHash,
} from './io.js';
export { appendToSection } from './sections.js';
export { listTasks, completeTask, postponeTask } from './tasks.js';
export { searchNotes } from './search.js';
export { listRecent } from './recent.js';
export type { ListRecentOptions } from './recent.js';
export { getDailyNote, createDailyNote, formatDailyName } from './daily.js';
export { getVaultTree } from './tree.js';
