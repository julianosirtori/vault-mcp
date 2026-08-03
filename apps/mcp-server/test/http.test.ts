import fs from 'node:fs/promises';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { openVault } from '@vault-mcp/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createHttpServer } from '../src/http.js';

const SECRET = 'h'.repeat(48);
const MAX_BODY_BYTES = 4 * 1024 * 1024;

let vaultRoot: string;
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-mcp-http-'));
  await fs.writeFile(path.join(vaultRoot, 'note.md'), '# Note\n');
  const config = loadConfig({ VAULT_PATH: vaultRoot, ORIGIN_SECRET: SECRET });
  const vault = await openVault({ root: config.vaultPath });
  server = createHttpServer(config, vault);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fs.rm(vaultRoot, { recursive: true, force: true });
});

describe('POST /mcp body limit', () => {
  it('answers 413 instead of resetting the connection', async () => {
    // A client that overshoots the limit must learn *why*: a connection reset
    // is opaque and invites a retry with the same oversized payload.
    const oversized = 'x'.repeat(MAX_BODY_BYTES + 1024 * 1024);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'x-origin-secret': SECRET,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', big: oversized }),
    });
    expect(res.status).toBe(413);
    await res.arrayBuffer();
  });

  it('still serves a normal-sized request on the same server', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'x-origin-secret': SECRET,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(200);
    await res.arrayBuffer();
  });

  it('rejects a body that is oversized but still valid JSON, without parsing it', async () => {
    const filler = 'y'.repeat(MAX_BODY_BYTES);
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'x-origin-secret': SECRET,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', filler }),
    });
    expect(res.status).toBe(413);
    await res.arrayBuffer();
  });
});
