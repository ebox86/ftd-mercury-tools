import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';
import { SMTPServer } from 'smtp-server';
import { getConfigDir } from './config';

export function getQueueDir(): string {
  return path.join(getConfigDir(), 'mailqueue');
}

function ensureQueueDir(): string {
  const dir = getQueueDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ── SMTP server ───────────────────────────────────────────────────────────────
// Accepts the WOI email from nodemailer and writes it as an .eml file to the
// queue directory for Mercury to collect via POP3.

export async function startSmtpServer(port: number): Promise<SMTPServer> {
  const queueDir = ensureQueueDir();

  const server = new SMTPServer({
    secure: false,
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const filename = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.eml`;
        try {
          fs.writeFileSync(path.join(queueDir, filename), Buffer.concat(chunks));
          console.log(`[Relay/SMTP] Queued: ${filename}`);
          callback();
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          console.error(`[Relay/SMTP] Store failed: ${error.message}`);
          callback(error);
        }
      });
      stream.on('error', (err: Error) => callback(err));
    },
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      console.log(`[Relay/SMTP] Listening on 127.0.0.1:${port}`);
      resolve();
    });
  });

  server.on('error', (err: Error) =>
    console.error(`[Relay/SMTP] ${err.message}`)
  );

  return server;
}

// ── POP3 server ───────────────────────────────────────────────────────────────
// Serves queued .eml files to Mercury using the POP3 protocol (RFC 1939).
// Only the commands Mercury actually issues are implemented.

export async function startPop3Server(port: number): Promise<net.Server> {
  ensureQueueDir();

  const server = net.createServer((socket) => {
    const queueDir = getQueueDir();
    let authenticated = false;
    const toDelete = new Set<string>();
    let messages: string[] = [];

    const send = (line: string) => socket.write(line + '\r\n');

    send('+OK POP3 server ready');

    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('data', (data: string) => {
      buffer += data;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const trimmed = raw.trim();
        if (!trimmed) continue;

        const spaceAt = trimmed.indexOf(' ');
        const cmd = (spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt)).toUpperCase();
        const arg = spaceAt === -1 ? '' : trimmed.slice(spaceAt + 1);

        switch (cmd) {
          case 'CAPA':
            send('+OK');
            socket.write('USER\r\nUIDL\r\nRESP-CODES\r\n.\r\n');
            break;

          case 'USER':
            send('+OK');
            break;

          case 'PASS':
            authenticated = true;
            messages = listQueue(queueDir);
            send(`+OK ${messages.length} message(s)`);
            break;

          case 'STAT': {
            if (!authenticated) { send('-ERR not authenticated'); break; }
            const avail = visible(messages, toDelete);
            const size  = avail.reduce((s, m) => s + fileSize(queueDir, m), 0);
            send(`+OK ${avail.length} ${size}`);
            break;
          }

          case 'LIST': {
            if (!authenticated) { send('-ERR not authenticated'); break; }
            if (arg) {
              const i = parseInt(arg, 10) - 1;
              const message = getMessage(messages, toDelete, i);
              if (!message) { send('-ERR no such message'); break; }
              send(`+OK ${i + 1} ${fileSize(queueDir, message)}`);
            } else {
              send('+OK');
              messages.forEach((m, i) => {
                if (!toDelete.has(m)) socket.write(`${i + 1} ${fileSize(queueDir, m)}\r\n`);
              });
              socket.write('.\r\n');
            }
            break;
          }

          case 'UIDL': {
            if (!authenticated) { send('-ERR not authenticated'); break; }
            if (arg) {
              const i = parseInt(arg, 10) - 1;
              const message = getMessage(messages, toDelete, i);
              if (!message) { send('-ERR no such message'); break; }
              send(`+OK ${i + 1} ${message}`);
            } else {
              send('+OK');
              messages.forEach((m, i) => {
                if (!toDelete.has(m)) socket.write(`${i + 1} ${m}\r\n`);
              });
              socket.write('.\r\n');
            }
            break;
          }

          case 'RETR': {
            if (!authenticated) { send('-ERR not authenticated'); break; }
            const i = parseInt(arg, 10) - 1;
            const message = getMessage(messages, toDelete, i);
            if (!message) { send('-ERR no such message'); break; }
            try {
              const raw = fs.readFileSync(path.join(queueDir, message));
              send(`+OK ${raw.length} octets`);
              // Normalise line endings then byte-stuff lines beginning with '.'
              const emlLines = raw.toString('binary')
                .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                .split('\n');
              for (const l of emlLines)
                socket.write((l.startsWith('.') ? '.' + l : l) + '\r\n', 'binary');
              socket.write('.\r\n');
            } catch {
              send('-ERR cannot read message');
            }
            break;
          }

          case 'DELE': {
            if (!authenticated) { send('-ERR not authenticated'); break; }
            const i = parseInt(arg, 10) - 1;
            const message = getMessage(messages, toDelete, i);
            if (!message) { send('-ERR no such message'); break; }
            toDelete.add(message);
            send('+OK');
            break;
          }

          case 'NOOP':
            send('+OK');
            break;

          case 'RSET':
            toDelete.clear();
            send('+OK');
            break;

          case 'QUIT':
            for (const m of toDelete) {
              try { fs.unlinkSync(path.join(queueDir, m)); } catch { /* non-fatal */ }
            }
            console.log(`[Relay/POP3] Session closed — deleted ${toDelete.size} message(s)`);
            send('+OK bye');
            socket.end();
            break;

          default:
            send('-ERR unknown command');
        }
      }
    });

    socket.on('error', () => { /* client disconnected unexpectedly */ });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError);
      console.log(`[Relay/POP3] Listening on 127.0.0.1:${port}`);
      resolve();
    });
  });

  server.on('error', (err: Error) =>
    console.error(`[Relay/POP3] ${err.message}`)
  );

  return server;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function listQueue(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.eml')).sort();
  } catch {
    return [];
  }
}

function visible(messages: string[], toDelete: Set<string>): string[] {
  return messages.filter(m => !toDelete.has(m));
}

function getMessage(messages: string[], toDelete: Set<string>, index: number): string | undefined {
  if (index < 0 || index >= messages.length) return undefined;
  const message = messages[index];
  return toDelete.has(message) ? undefined : message;
}

function fileSize(dir: string, filename: string): number {
  try { return fs.statSync(path.join(dir, filename)).size; }
  catch { return 0; }
}
