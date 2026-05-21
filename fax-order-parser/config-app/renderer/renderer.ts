// Renderer process — runs in the browser context (sandboxed).
// All Node.js/Electron calls go through window.faxParserApi (exposed by preload).

interface FaxParserApi {
  loadConfig(): Promise<Record<string, unknown>>;
  saveConfig(config: Record<string, unknown>): Promise<{ ok: boolean }>;
  readLog(): Promise<OrderLogEntry[]>;
  serviceStatus(): Promise<string>;
  serviceStart(): Promise<{ ok: boolean; error?: string }>;
  serviceStop(): Promise<{ ok: boolean; error?: string }>;
  openFolder(path: string): void;
}

interface OrderLogEntry {
  timestamp: string;
  fileName: string;
  orderNumber?: string;
  customerName?: string;
  deliveryDate?: string;
  emailSent: boolean;
  error?: string;
}

declare const window: Window & { faxParserApi: FaxParserApi };

// ── Helpers ───────────────────────────────────────────────────────────────────

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function toast(msg: string, isError = false): void {
  const el = $<HTMLDivElement>('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout((el as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer);
  (el as HTMLElement & { _timer?: ReturnType<typeof setTimeout> })._timer = setTimeout(() => {
    el.classList.add('hidden');
  }, 3000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset['tab'];
    document.getElementById(`tab-${target}`)?.classList.add('active');
    if (target === 'log') loadLog();
  });
});

// ── Config load / save ────────────────────────────────────────────────────────

async function loadConfig(): Promise<void> {
  const cfg = await window.faxParserApi.loadConfig();
  const email = (cfg['email'] as Record<string, unknown>) ?? {};

  ($<HTMLInputElement>('watchFolder')).value        = String(cfg['watchFolder'] ?? '');
  ($<HTMLInputElement>('pollInterval')).value       = String(cfg['pollIntervalSeconds'] ?? 10);
  ($<HTMLSelectElement>('fileFormat')).value        = String(cfg['fileFormat'] ?? 'PDF');
  ($<HTMLInputElement>('processedSubfolder')).value = String(cfg['processedSubfolder'] ?? 'processed');

  ($<HTMLInputElement>('senderAddress')).value      = String(email['senderAddress'] ?? '');
  ($<HTMLInputElement>('senderPassword')).value     = String(email['senderPassword'] ?? '');
  ($<HTMLInputElement>('recipientAddress')).value   = String(email['recipientAddress'] ?? '');
  ($<HTMLInputElement>('subjectLine')).value        = String(email['subjectLine'] ?? '');
  ($<HTMLInputElement>('encryptionPassword')).value = String(email['encryptionPassword'] ?? '');
  ($<HTMLSelectElement>('encryptionAlgorithm')).value = String(email['encryptionAlgorithm'] ?? 'TripleDES');
  ($<HTMLInputElement>('smtpHost')).value           = String(email['smtpHost'] ?? '');
  ($<HTMLInputElement>('smtpPort')).value           = String(email['smtpPort'] ?? 587);
}

async function saveConfig(): Promise<void> {
  const config = {
    watchFolder:         $<HTMLInputElement>('watchFolder').value.trim(),
    pollIntervalSeconds: parseInt($<HTMLInputElement>('pollInterval').value, 10) || 10,
    fileFormat:          $<HTMLSelectElement>('fileFormat').value,
    processedSubfolder:  $<HTMLInputElement>('processedSubfolder').value.trim() || 'processed',
    email: {
      senderAddress:      $<HTMLInputElement>('senderAddress').value.trim(),
      senderPassword:     $<HTMLInputElement>('senderPassword').value,
      recipientAddress:   $<HTMLInputElement>('recipientAddress').value.trim(),
      subjectLine:        $<HTMLInputElement>('subjectLine').value.trim(),
      encryptionPassword: $<HTMLInputElement>('encryptionPassword').value,
      encryptionAlgorithm:$<HTMLSelectElement>('encryptionAlgorithm').value as any,
      smtpHost:           $<HTMLInputElement>('smtpHost').value.trim(),
      smtpPort:           parseInt($<HTMLInputElement>('smtpPort').value, 10) || 587,
    },
  };

  const result = await window.faxParserApi.saveConfig(config);
  if (result.ok) {
    toast('Settings saved.');
  } else {
    toast('Failed to save settings.', true);
  }
}

$('btn-save').addEventListener('click', saveConfig);

// ── Open watch folder ─────────────────────────────────────────────────────────

$('btn-open-folder').addEventListener('click', () => {
  const folder = $<HTMLInputElement>('watchFolder').value.trim();
  if (folder) window.faxParserApi.openFolder(folder);
});

// ── Service controls ──────────────────────────────────────────────────────────

async function refreshServiceStatus(): Promise<void> {
  const status = await window.faxParserApi.serviceStatus();
  const badge = $<HTMLSpanElement>('service-badge');
  badge.textContent = `Service: ${status}`;
  badge.className = 'badge badge-' + (status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown');
}

$('btn-svc-start').addEventListener('click', async () => {
  const result = await window.faxParserApi.serviceStart();
  if (result.ok) {
    toast('Service started.');
  } else {
    toast(`Failed to start service: ${result.error ?? 'unknown error'}`, true);
  }
  await refreshServiceStatus();
});

$('btn-svc-stop').addEventListener('click', async () => {
  const result = await window.faxParserApi.serviceStop();
  if (result.ok) {
    toast('Service stopped.');
  } else {
    toast(`Failed to stop service: ${result.error ?? 'unknown error'}`, true);
  }
  await refreshServiceStatus();
});

// ── Order log ─────────────────────────────────────────────────────────────────

async function loadLog(): Promise<void> {
  const entries = await window.faxParserApi.readLog();
  const tbody = $<HTMLTableSectionElement>('log-body');
  const count = $<HTMLSpanElement>('log-count');

  count.textContent = `${entries.length} record${entries.length !== 1 ? 's' : ''}`;

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No orders processed yet.</td></tr>';
    return;
  }

  // Show newest first
  const sorted = [...entries].reverse();
  tbody.innerHTML = sorted.map(e => {
    const ts = new Date(e.timestamp).toLocaleString();
    const emailCell = e.emailSent
      ? '<span class="email-ok">✓ Sent</span>'
      : `<span class="email-err">✗ Failed</span>`;
    const note = e.error ? `<span title="${escHtml(e.error)}">⚠ ${escHtml(e.error.slice(0, 40))}…</span>` : '';
    return `<tr>
      <td>${ts}</td>
      <td>${escHtml(e.fileName)}</td>
      <td>${escHtml(e.orderNumber ?? '')}</td>
      <td>${escHtml(e.customerName ?? '')}</td>
      <td>${escHtml(e.deliveryDate ?? '')}</td>
      <td>${emailCell}</td>
      <td>${note}</td>
    </tr>`;
  }).join('');
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

$('btn-refresh-log').addEventListener('click', loadLog);

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadConfig();
  await refreshServiceStatus();
  // Refresh service status every 15 s
  setInterval(refreshServiceStatus, 15_000);
})();
