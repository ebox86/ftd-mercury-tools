import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const webHost = String(process.env.WEB_HOST || '0.0.0.0').trim() || '0.0.0.0';
const webPort = Number(process.env.WEB_PORT || 5173);
const workflowApiBaseUrl = String(process.env.WORKFLOW_API_BASE_URL || 'http://127.0.0.1:17344').trim().replace(/\/+$/, '');
const distDir = join(__dirname, '..', 'kiosk-app', 'dist');

if (!Number.isFinite(webPort) || webPort <= 0 || webPort > 65535) {
  throw new Error(`WEB_PORT must be a valid port. Got: ${process.env.WEB_PORT}`);
}

if (!existsSync(distDir)) {
  throw new Error(`Kiosk dist directory not found: ${distDir}. Build kiosk-app before starting this service.`);
}

const mimeByExt = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.mjs', 'application/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.webp', 'image/webp'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
]);

function normalizeClientPath(pathname) {
  let raw = String(pathname || '/');
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // keep raw path if malformed encoding
  }

  if (raw === '/' || !raw) {
    return 'index.html';
  }

  const candidate = normalize(raw).replace(/^([/\\])+/, '');
  if (!candidate || candidate.startsWith('..')) {
    return 'index.html';
  }
  return candidate;
}

function safeFilePath(pathname) {
  const rel = normalizeClientPath(pathname);
  const fullPath = join(distDir, rel);
  const normalizedRoot = normalize(`${distDir}\\`).toLowerCase();
  const normalizedTarget = normalize(fullPath).toLowerCase();

  if (!normalizedTarget.startsWith(normalizedRoot)) {
    return null;
  }

  if (existsSync(fullPath) && statSync(fullPath).isFile()) {
    return fullPath;
  }

  if (extname(rel)) {
    return null;
  }

  const fallback = join(distDir, 'index.html');
  if (existsSync(fallback) && statSync(fallback).isFile()) {
    return fallback;
  }
  return null;
}

function contentTypeFor(filePath) {
  return mimeByExt.get(extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function proxyApiRequest(req, res, targetBaseUrl) {
  const targetUrl = new URL(req.url || '/', targetBaseUrl);
  const useHttps = targetUrl.protocol === 'https:';
  const transport = useHttps ? httpsRequest : httpRequest;

  const upstream = transport(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (useHttps ? 443 : 80),
      method: req.method || 'GET',
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers: {
        ...req.headers,
        host: targetUrl.host,
        connection: 'close',
      },
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.on('error', (error) => {
    sendJson(res, 502, {
      error: `Cannot reach workflow API at ${targetBaseUrl}`,
      detail: String(error?.message || error),
    });
  });

  req.pipe(upstream);
}

const server = createServer((req, res) => {
  const reqUrl = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${webPort}`}`);
  const pathname = reqUrl.pathname;

  if (pathname === '/web-health') {
    return sendJson(res, 200, {
      ok: true,
      service: 'mercury-dashboard-web-host',
      workflowApiBaseUrl,
      distDir,
    });
  }

  if (pathname === '/health' || pathname.startsWith('/api/')) {
    proxyApiRequest(req, res, workflowApiBaseUrl);
    return;
  }

  const filePath = safeFilePath(pathname);
  if (!filePath) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Cache-Control': filePath.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(filePath).pipe(res);
});

server.listen(webPort, webHost, () => {
  // eslint-disable-next-line no-console
  console.log(`Dashboard web host listening on http://${webHost}:${webPort} (API -> ${workflowApiBaseUrl})`);
});

function shutdown(signalName) {
  // eslint-disable-next-line no-console
  console.log(`Received ${signalName}, stopping dashboard web host...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
