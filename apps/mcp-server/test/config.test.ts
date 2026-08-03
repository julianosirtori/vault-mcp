import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const SECRET = 'a'.repeat(48);

describe('loadConfig', () => {
  it('aggregates every problem into a single error', () => {
    expect(() => loadConfig({ MCP_PORT: 'nope', ORIGIN_SECRET: 'short' })).toThrow(
      /VAULT_PATH[\s\S]*MCP_PORT[\s\S]*ORIGIN_SECRET/,
    );
  });

  it('applies defaults', () => {
    const config = loadConfig({ VAULT_PATH: '/v', ORIGIN_SECRET: SECRET });
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 9820,
      maxReadBytes: 200000,
      lowTrustFolders: [],
      allowInsecureLocal: false,
    });
  });

  it('rejects relative VAULT_PATH', () => {
    expect(() => loadConfig({ VAULT_PATH: 'vault', ORIGIN_SECRET: SECRET })).toThrow(
      /must be absolute/,
    );
  });

  it('parses LOW_TRUST_FOLDERS', () => {
    const config = loadConfig({
      VAULT_PATH: '/v',
      ORIGIN_SECRET: SECRET,
      LOW_TRUST_FOLDERS: ' clippings , inbox/web ,',
    });
    expect(config.lowTrustFolders).toEqual(['clippings', 'inbox/web']);
  });

  it('requires ORIGIN_SECRET unless insecure local mode is on', () => {
    expect(() => loadConfig({ VAULT_PATH: '/v' })).toThrow(/ORIGIN_SECRET is required/);
    const config = loadConfig({ VAULT_PATH: '/v', MCP_ALLOW_INSECURE_LOCAL: '1' });
    expect(config.allowInsecureLocal).toBe(true);
    expect(config.originSecret).toBeNull();
  });

  it('refuses insecure local mode on a non-loopback host', () => {
    expect(() =>
      loadConfig({ VAULT_PATH: '/v', MCP_ALLOW_INSECURE_LOCAL: '1', MCP_HOST: '0.0.0.0' }),
    ).toThrow(/loopback/);
  });
});
