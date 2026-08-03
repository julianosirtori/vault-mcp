import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Vault } from '@vault-mcp/core';
import type { ServerConfig } from './config.js';
import { buildServer } from './server.js';

const MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * How much of an oversized body is drained after the limit is hit. Draining is
 * what makes the 413 deliverable: closing the socket while the client is still
 * uploading resets the connection, and the client sees ECONNRESET instead of a
 * status it can act on. The cap keeps an endless stream from holding the
 * connection open forever.
 */
const MAX_DRAIN_BYTES = 4 * 1024 * 1024;

/** Constant-time comparison; hashing first makes length differences moot. */
function secretsMatch(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function gatePasses(req: http.IncomingMessage, config: ServerConfig): boolean {
  if (config.allowInsecureLocal) return true;
  const header = req.headers['x-origin-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !config.originSecret) return false;
  return secretsMatch(provided, config.originSecret);
}

/** 404, empty body — never 401: nothing here confirms that anything exists. */
function deny(res: http.ServerResponse): void {
  res.writeHead(404).end();
}

/** Reads the body, or resolves null when it exceeds MAX_BODY_BYTES. */
function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let drained = 0;
    let settled = false;
    const settle = (value: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    req.on('data', (chunk: Buffer) => {
      if (overflow) {
        drained += chunk.length;
        // An unbounded stream gets hung up on; the 413 below then goes
        // nowhere, which is the correct outcome for a client that ignores it.
        if (drained > MAX_DRAIN_BYTES) {
          settle(null);
          req.destroy();
        }
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        // The partial body is unusable — drop it instead of holding 4 MB.
        chunks = [];
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle(overflow ? null : Buffer.concat(chunks)));
    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

async function handleMcpPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  vault: Vault,
): Promise<void> {
  const body = await readBody(req);
  if (body === null) {
    res.writeHead(413, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Request body too large' },
        id: null,
      }),
    );
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body.toString('utf8'));
  } catch {
    res.writeHead(400, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      }),
    );
    return;
  }

  // Stateless streamable HTTP: a fresh server + transport pair per request.
  const server = buildServer(vault);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
}

export function createHttpServer(config: ServerConfig, vault: Vault): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      // The gate comes before any routing: without the shared secret the
      // origin is indistinguishable from nothing.
      if (!gatePasses(req, config)) {
        deny(res);
        return;
      }

      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'origin'}`);

      if (url.pathname === '/mcp') {
        if (req.method === 'POST') {
          await handleMcpPost(req, res, vault);
          return;
        }
        // Stateless mode: no SSE stream, no session to delete.
        res.writeHead(405, { allow: 'POST' }).end();
        return;
      }

      if (url.pathname === '/healthz' && req.method === 'GET') {
        try {
          await fs.stat(vault.root);
          res
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: true, vault: true }));
        } catch {
          res
            .writeHead(503, { 'content-type': 'application/json' })
            .end(JSON.stringify({ ok: false, vault: false }));
        }
        return;
      }

      deny(res);
    })().catch((err) => {
      console.error('[vault-mcp] request handling failed:', err);
      if (!res.headersSent) res.writeHead(500).end();
      else res.end();
    });
  });
}
