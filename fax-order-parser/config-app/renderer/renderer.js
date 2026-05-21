// Renderer process — runs in Electron's renderer (browser) context.
// All Node.js/Electron access goes through window.faxParserApi (set up in preload.js).

/** @param {string} id */
function $(id) {
  return document.getElementById(id);
}

/** @param {string} msg @param {boolean} [isError] */
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout(el._timer);
  el._timer = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.getElementById(`tab-${target}`)?.classList.add('active');
    if (target === 'log') loadLog();
  });
});

// ── Config load / save ────────────────────────────────────────────────────────

async function loadConfig() {
  const cfg = await window.faxParserApi.loadConfig();
  const email = cfg.email ?? {};

  $('watchFolder').value        = cfg.watchFolder ?? '';
  $('pollInterval').value       = cfg.pollIntervalSeconds ?? 10;
  $('fileFormat').value         = cfg.fileFormat ?? 'PDF';
  $('processedSubfolder').value = cfg.processedSubfolder ?? 'processed';

  $('senderAddress').value        = email.senderAddress   ?? '';
  $('senderPassword').value       = email.senderPassword  ?? '';
  $('recipientAddress').value     = email.recipientAddress ?? '';
  $('subjectLine').value          = email.subjectLine      ?? '';
  $('encryptionPassword').value   = email.encryptionPassword ?? '';
  $('encryptionAlgorithm').value  = email.encryptionAlgorithm ?? 'TripleDES';
  $('smtpHost').value             = email.smtpHost         ?? '';
  $('smtpPort').value             = email.smtpPort         ?? 587;
}

async function saveConfig() {
  const config = {
    watchFolder:         $('watchFolder').value.trim(),
    pollIntervalSeconds: parseInt($('pollInterval').value, 10) || 10,
    fileFormat:          $('fileFormat').value,
    processedSubfolder:  $('processedSubfolder').value.trim() || 'processed',
    email: {
      senderAddress:      $('senderAddress').value.trim(),
      senderPassword:     $('senderPassword').value,
      recipientAddress:   $('recipientAddress').value.trim(),
      subjectLine:        $('subjectLine').value.trim(),
      encryptionPassword: $('encryptionPassword').value,
      encryptionAlgorithm:$('encryptionAlgorithm').value,
      smtpHost:           $('smtpHost').value.trim(),
      smtpPort:           parseInt($('smtpPort').value, 10) || 587,
    },
  };

  const result = await window.faxParserApi.saveConfig(config);
  toast(result.ok ? 'Settings saved.' : 'Failed to save settings.', !result.ok);
}

$('btn-save').addEventListener('click', saveConfig);

// ── Open watch folder ─────────────────────────────────────────────────────────

$('btn-open-folder').addEventListener('click', () => {
  const folder = $('watchFolder').value.trim();
  if (folder) window.faxParserApi.openFolder(folder);
});

// ── Service controls ──────────────────────────────────────────────────────────

async function refreshServiceStatus() {
  const status = await window.faxParserApi.serviceStatus();
  const badge = $('service-badge');
  badge.textContent = `Service: ${status}`;
  badge.className = 'badge badge-' +
    (status === 'running' ? 'running' : status === 'stopped' ? 'stopped' : 'unknown');
}

$('btn-svc-start').addEventListener('click', async () => {
  const result = await window.faxParserApi.serviceStart();
  toast(result.ok ? 'Service started.' : `Failed to start service: ${result.error ?? 'unknown error'}`, !result.ok);
  await refreshServiceStatus();
});

$('btn-svc-stop').addEventListener('click', async () => {
  const result = await window.faxParserApi.serviceStop();
  toast(result.ok ? 'Service stopped.' : `Failed to stop service: ${result.error ?? 'unknown error'}`, !result.ok);
  await refreshServiceStatus();
});

// ── Order log ─────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadLog() {
  const entries = await window.faxParserApi.readLog();
  const tbody = $('log-body');
  const count = $('log-count');

  count.textContent = `${entries.length} record${entries.length !== 1 ? 's' : ''}`;

  if (entries.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-row">No orders processed yet.</td></tr>';
    return;
  }

  tbody.innerHTML = [...entries].reverse().map(e => {
    const ts = new Date(e.timestamp).toLocaleString();
    const emailCell = e.emailSent
      ? '<span class="email-ok">✓ Sent</span>'
      : '<span class="email-err">✗ Not sent</span>';
    const note = e.error
      ? `<span title="${escHtml(e.error)}">⚠ ${escHtml(e.error.slice(0, 50))}…</span>`
      : '';
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

$('btn-refresh-log').addEventListener('click', loadLog);

// ── Init ──────────────────────────────────────────────────────────────────────

(async () => {
  await loadConfig();
  await refreshServiceStatus();
  setInterval(refreshServiceStatus, 15_000);
})();
