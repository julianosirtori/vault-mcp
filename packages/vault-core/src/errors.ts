export type VaultErrorCode =
  | 'INVALID_PATH'
  | 'OUTSIDE_VAULT'
  | 'HIDDEN_PATH'
  | 'NOT_MARKDOWN'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'NOT_A_FILE';

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
  }
}
