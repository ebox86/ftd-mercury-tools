// Runs a throwaway dev copy of the bridge + kiosk app, fully isolated from
// any installed/live instance: different ports, and a separate data
// directory (.dev-data/) so device pairing / Workbench users you create
// while poking around never touch the real device-tokens.json or
// workbench-users.json. Safe to run alongside a live installed service.
//
// Note: this only runs the bridge + kiosk-app dev server, not the root
// login page (that's served by dashboard-web-server.mjs) - use
// `npm run preview` to test the login flow end-to-end.
//
// Usage: npm run dev   (from mercury-orders-tv-dashboard/)
// Env overrides: DEV_BRIDGE_PORT, DEV_KIOSK_PORT, MERCURY_BASE_URL

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bridgeDir = join(rootDir, 'workflow-bridge');
const kioskDir = join(rootDir, 'kiosk-app');
const dataDir = join(rootDir, '.dev-data');

const bridgePort = Number(process.env.DEV_BRIDGE_PORT || 18344);
const kioskPort = Number(process.env.DEV_KIOSK_PORT || 5180);

mkdirSync(dataDir, { recursive: true });

console.log('Starting an isolated dev instance (does not touch any live/installed service):');
console.log(`  Bridge:     http://127.0.0.1:${bridgePort}  (data dir: ${dataDir})`);
console.log(`  Kiosk app:  http://127.0.0.1:${kioskPort}`);
console.log(`  Workbench:  http://127.0.0.1:${bridgePort}/workbench  (no login page here - use "npm run preview" for that)`);
console.log('Ctrl+C to stop both.\n');

function prefixedPipe(child, label) {
  const handle = (stream) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length) console.log(`[${label}] ${line}`);
      }
    });
  };
  handle(child.stdout);
  handle(child.stderr);
}

const bridge = spawn(process.execPath, ['server.mjs'], {
  cwd: bridgeDir,
  env: {
    ...process.env,
    PORT: String(bridgePort),
    MERCURY_DATA_DIR: dataDir,
    MERCURY_BASE_URL: process.env.MERCURY_BASE_URL || 'http://127.0.0.1/WsMercuryWebAPI',
  },
});
prefixedPipe(bridge, 'bridge');

const kiosk = spawn(`npx vite --port ${kioskPort} --host`, {
  cwd: kioskDir,
  shell: true,
  env: {
    ...process.env,
    VITE_WORKFLOW_PROXY_TARGET: `http://127.0.0.1:${bridgePort}`,
  },
});
prefixedPipe(kiosk, 'kiosk');

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping dev instance...');
  bridge.kill();
  kiosk.kill();
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
bridge.on('exit', (code) => {
  if (!shuttingDown) {
    console.log(`[bridge] exited (code ${code})`);
    shutdown();
  }
});
kiosk.on('exit', (code) => {
  if (!shuttingDown) {
    console.log(`[kiosk] exited (code ${code})`);
    shutdown();
  }
});
