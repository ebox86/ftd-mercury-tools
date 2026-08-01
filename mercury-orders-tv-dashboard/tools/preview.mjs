// Builds the kiosk app and serves it through the same static-file + /api
// proxy server that runs in production (service-host/dashboard-web-server.mjs),
// instead of the Vite dev server. Use this specifically to test anything
// deployment-path-related (e.g. behind the IIS /Talaria reverse proxy) -
// `npm run dev`'s dev server doesn't honor relative asset paths, so it can't
// stand in for this. Fully isolated from any installed/live instance, same
// as `npm run dev` (separate ports, separate .dev-data/ directory).
//
// Usage: npm run preview   (from mercury-orders-tv-dashboard/)
// Then, in an elevated prompt, point IIS at it:
//   .\tools\setup-iis-proxy.ps1 -UpstreamUrl http://127.0.0.1:<web port>
// Env overrides: DEV_BRIDGE_PORT, DEV_WEB_PORT, MERCURY_BASE_URL

import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const bridgeDir = join(rootDir, 'workflow-bridge');
const kioskDir = join(rootDir, 'kiosk-app');
const serviceHostDir = join(rootDir, 'service-host');
const dataDir = join(rootDir, '.dev-data');

const bridgePort = Number(process.env.DEV_BRIDGE_PORT || 18344);
const webPort = Number(process.env.DEV_WEB_PORT || 5195);

mkdirSync(dataDir, { recursive: true });

console.log('Building kiosk app (npm run build)...');
const build = spawnSync('npx vite build', { cwd: kioskDir, shell: true, stdio: 'inherit' });
if (build.status !== 0) {
  console.error('Build failed - fix the error above before previewing.');
  process.exit(build.status ?? 1);
}

console.log('\nStarting an isolated preview instance (does not touch any live/installed service):');
console.log(`  Bridge:     http://127.0.0.1:${bridgePort}  (data dir: ${dataDir})`);
console.log(`  Web:        http://127.0.0.1:${webPort}  (serving kiosk-app/dist)`);
console.log(`  Admin UI:   http://127.0.0.1:${bridgePort}/admin`);
console.log(`\nTo test through IIS, in an elevated prompt run:`);
console.log(`  .\\tools\\setup-iis-proxy.ps1 -UpstreamUrl http://127.0.0.1:${webPort}`);
console.log('\nCtrl+C to stop both.\n');

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

const web = spawn(process.execPath, ['dashboard-web-server.mjs'], {
  cwd: serviceHostDir,
  env: {
    ...process.env,
    WEB_PORT: String(webPort),
    WEB_HOST: '0.0.0.0',
    WORKFLOW_API_BASE_URL: `http://127.0.0.1:${bridgePort}`,
  },
});
prefixedPipe(web, 'web');

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\nStopping preview instance...');
  bridge.kill();
  web.kill();
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
web.on('exit', (code) => {
  if (!shuttingDown) {
    console.log(`[web] exited (code ${code})`);
    shutdown();
  }
});
