#!/usr/bin/env node
/**
 * Entry point. Opens the database, wires the request handler, listens.
 *
 * Configuration comes from the environment:
 *   PORT          (default 4321)
 *   HOST          (default 127.0.0.1 - local only). A comma-separated list
 *                 binds several addresses, which is how the app can answer
 *                 both a local proxy and a private network interface.
 *   SIT_STAND_DB  (default ./data/sit-stand.db)
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequestHandler } from './lib/api.js';
import { openDatabase } from './lib/db.js';
import { createBroadcaster } from './lib/events.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 4321);
const HOSTS = (process.env.HOST ?? '127.0.0.1')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);
const DATABASE_FILE = process.env.SIT_STAND_DB ?? path.join(HERE, 'data', 'sit-stand.db');

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`PORT must be a number between 1 and 65535, got ${process.env.PORT}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(DATABASE_FILE), { recursive: true });

const store = openDatabase(DATABASE_FILE);
const broadcaster = createBroadcaster();
const handler = createRequestHandler({ store, broadcaster });

// One listener per address. They share a handler and a database, so it is the
// same tracker however you reach it.
const servers = HOSTS.map((host) => {
  const server = http.createServer(handler);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`${host}:${PORT} is already in use. Try: PORT=4322 npm start`);
    } else if (error.code === 'EADDRNOTAVAIL') {
      console.error(`${host} is not an address on this machine.`);
    } else {
      console.error(`Server error on ${host}:`, error.message);
    }
    process.exit(1);
  });

  server.listen(PORT, host, () => {
    console.log(`Sit/stand tracker running at http://${host}:${PORT}`);
  });
  return server;
});

console.log(`Data: ${DATABASE_FILE}`);

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\nStopping. Your data is saved.');
    // Live streams hold their connections open, so let them go or the
    // listeners will never finish closing.
    broadcaster.closeAll();
    let remaining = servers.length;
    for (const server of servers) {
      server.close(() => {
        remaining -= 1;
        if (remaining === 0) {
          store.close();
          process.exit(0);
        }
      });
    }
    // Do not hang forever on a client holding the connection open.
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
