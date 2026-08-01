(function () {
  var loginView = document.getElementById('login-view');
  var cpwView = document.getElementById('change-password-view');
  var shell = document.getElementById('app-shell');

  function showOnly(view) {
    [loginView, cpwView, shell].forEach(function (v) { v.classList.add('hidden'); });
    view.classList.remove('hidden');
  }

  // This page always lives at ".../admin/" - whatever comes before that in
  // the current URL (nothing when hit directly on the bridge, "/Talaria"
  // when proxied through IIS, etc.) has to be prepended to every API call,
  // or requests miss any upstream reverse proxy and 404 at the site root.
  var sitePrefix = window.location.pathname.replace(/\/admin\/?$/, '');

  var currentDashboardUrl = '';

  function api(method, path, body) {
    return fetch(sitePrefix + path, {
      method: method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) {}
        return { ok: res.ok, status: res.status, data: data };
      });
    });
  }

  function fmtDate(raw) {
    if (!raw) return 'Never';
    var d = new Date(raw);
    if (isNaN(d.getTime())) return 'Never';
    return d.toLocaleString();
  }

  // ---- Dashboard URL (for the TV pairing instructions) ----
  // "localhost"/"127.0.0.1" in the address bar means nothing to another
  // device - if that's what this admin page was opened with, ask the bridge
  // for its actual LAN-facing address(es) instead. Otherwise trust the host
  // already in the address bar (it got this browser here, so it's proven
  // reachable), and offer any other detected interfaces as alternates.
  var currentHostname = window.location.hostname.toLowerCase();
  var isLoopbackHost = currentHostname === 'localhost'
    || currentHostname === '::1'
    || currentHostname === '[::1]'
    || currentHostname.indexOf('127.') === 0;
  var pagePort = window.location.port ? (':' + window.location.port) : '';

  function buildDashboardUrl(host) {
    return window.location.protocol + '//' + host + pagePort + sitePrefix + '/dashboard/';
  }

  var dashboardUrlInfoPromise = api('GET', '/api/admin/network-info').then(function (r) {
    var addrs = (r.ok && r.data && r.data.addresses) || [];
    var detectedHostname = (r.ok && r.data && r.data.hostname) || '';

    if (!isLoopbackHost) {
      var alternates = [];
      addrs.forEach(function (addr) {
        if (addr.toLowerCase() !== window.location.hostname.toLowerCase()) alternates.push(buildDashboardUrl(addr));
      });
      if (detectedHostname && detectedHostname.toLowerCase() !== window.location.hostname.toLowerCase()) {
        alternates.push(buildDashboardUrl(detectedHostname));
      }
      return { primary: buildDashboardUrl(window.location.hostname), alternates: alternates, warning: '' };
    }

    if (!addrs.length && !detectedHostname) {
      return {
        primary: buildDashboardUrl(window.location.hostname),
        alternates: [],
        warning: "Could not detect this computer's LAN address — the URL below only works from this machine.",
      };
    }

    var primaryHost = addrs[0] || detectedHostname;
    var rest = [];
    addrs.slice(1).forEach(function (addr) { rest.push(buildDashboardUrl(addr)); });
    if (detectedHostname && detectedHostname.toLowerCase() !== primaryHost.toLowerCase()) {
      rest.push(buildDashboardUrl(detectedHostname));
    }
    return { primary: buildDashboardUrl(primaryHost), alternates: rest, warning: '' };
  }).catch(function () {
    return { primary: buildDashboardUrl(window.location.hostname), alternates: [], warning: '' };
  });

  function populateHowTo() {
    dashboardUrlInfoPromise.then(function (info) {
      currentDashboardUrl = info.primary;
      var mainEl = document.getElementById('howto-url');
      if (mainEl) mainEl.textContent = info.primary;
      var altEl = document.getElementById('howto-url-alt');
      if (altEl) {
        if (info.warning) {
          altEl.textContent = info.warning;
        } else if (info.alternates.length) {
          altEl.textContent = 'Or try: ' + info.alternates.join(', ');
        } else {
          altEl.textContent = '';
        }
      }
    });
  }

  // ---- Navigation ----

  var views = {
    overview: document.getElementById('view-overview'),
    devices: document.getElementById('view-devices'),
    account: document.getElementById('view-account'),
  };
  var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));

  function showView(name) {
    Object.keys(views).forEach(function (key) {
      views[key].classList.toggle('hidden', key !== name);
    });
    navItems.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === name);
    });
    if (name === 'overview') loadOverview();
    if (name === 'devices') loadDevices();
  }

  navItems.forEach(function (btn) {
    btn.addEventListener('click', function () {
      showView(btn.getAttribute('data-view'));
    });
  });

  // ---- Overview ----

  function statCard(label, value, tone) {
    var cls = tone ? ' ' + tone : '';
    return '<div class="stat-card"><div class="label">' + label + '</div><div class="value' + cls + '">' + value + '</div></div>';
  }

  function loadOverview() {
    var container = document.getElementById('overview-cards');
    container.innerHTML = '<div class="stat-card"><div class="label">Loading&hellip;</div></div>';
    fetch(sitePrefix + '/health', { cache: 'no-store' }).then(function (res) {
      return res.text().then(function (text) {
        var data = {};
        try { data = text ? JSON.parse(text) : {}; } catch (e) {}
        return { ok: res.ok, status: res.status, data: data };
      });
    }).then(function (r) {
      if (!r.ok) {
        container.innerHTML = '<div class="stat-card"><div class="label">Error (' + r.status + ')</div><div class="value warn">' + (r.data.error || 'Could not load /health') + '</div></div>';
        return;
      }
      var health = r.data;
      var policy = health.networkPolicy || {};
      var cards = [
        statCard('Mode', health.mode || 'unknown'),
        statCard('Local network only', policy.localNetworkOnly ? 'Yes' : 'No', policy.localNetworkOnly ? 'ok' : 'warn'),
        statCard('Device pairing', policy.deviceAuthEnabled ? 'Active' : 'Not set up', policy.deviceAuthEnabled ? 'ok' : 'warn'),
        statCard('Master API key', policy.apiKeyRequired ? 'Set' : 'Not set'),
        statCard('Mapbox', (health.mapbox && health.mapbox.enabled) ? 'Enabled' : 'Disabled', (health.mapbox && health.mapbox.enabled) ? 'ok' : ''),
      ];
      container.innerHTML = cards.join('');
    }).catch(function () {
      container.innerHTML = '<div class="stat-card"><div class="label">Error</div><div class="value warn">Could not reach the bridge</div></div>';
    });
  }

  // ---- Devices ----

  function showDevicesError(message) {
    var el = document.getElementById('devices-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  // A device's label defaults to read-only display + an explicit "rename"
  // button, rather than an always-editable input - an admin resting a cursor
  // in the wrong cell and typing (or a stray click) used to silently rename
  // the device on blur.
  function renderDeviceLabelDisplay(labelTd, device) {
    labelTd.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'device-label-display';

    var text = document.createElement('span');
    text.className = 'device-label-text';
    text.textContent = device.label;
    wrap.appendChild(text);

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-icon device-label-edit-btn';
    editBtn.title = 'Rename device';
    editBtn.textContent = String.fromCharCode(0x270e);
    editBtn.addEventListener('click', function () {
      renderDeviceLabelEditor(labelTd, device);
    });
    wrap.appendChild(editBtn);

    labelTd.appendChild(wrap);
  }

  function renderDeviceLabelEditor(labelTd, device) {
    labelTd.innerHTML = '';

    var wrap = document.createElement('div');
    wrap.className = 'device-label-edit-row';

    var input = document.createElement('input');
    input.type = 'text';
    input.value = device.label;
    wrap.appendChild(input);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-icon';
    saveBtn.title = 'Save name';
    saveBtn.textContent = String.fromCharCode(0x2713);
    wrap.appendChild(saveBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-icon';
    cancelBtn.title = 'Cancel';
    cancelBtn.textContent = String.fromCharCode(0x2715);
    wrap.appendChild(cancelBtn);

    function save() {
      var newLabel = input.value.trim();
      if (!newLabel || newLabel === device.label) {
        renderDeviceLabelDisplay(labelTd, device);
        return;
      }
      saveBtn.disabled = true;
      api('PATCH', '/api/workflow/devices/' + encodeURIComponent(device.id), { label: newLabel })
        .then(function (r) {
          if (!r.ok) {
            showDevicesError(r.data.error || 'Could not rename device');
            saveBtn.disabled = false;
            return;
          }
          device.label = newLabel;
          renderDeviceLabelDisplay(labelTd, device);
        });
    }

    saveBtn.addEventListener('click', save);
    cancelBtn.addEventListener('click', function () { renderDeviceLabelDisplay(labelTd, device); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') renderDeviceLabelDisplay(labelTd, device);
    });

    labelTd.appendChild(wrap);
    input.focus();
    input.select();
  }

  function renderDevices(devices) {
    var body = document.getElementById('devices-body');
    body.innerHTML = '';
    if (!devices.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" style="color:#8a91a6;">No devices paired yet &mdash; the bridge is open to any client until you add one.</td>';
      body.appendChild(tr);
      return;
    }
    devices.forEach(function (device) {
      var tr = document.createElement('tr');

      var labelTd = document.createElement('td');
      renderDeviceLabelDisplay(labelTd, device);
      tr.appendChild(labelTd);

      var statusTd = document.createElement('td');
      var pill = document.createElement('span');
      pill.className = 'pill ' + (device.enabled ? 'pill-on' : 'pill-off');
      pill.textContent = device.enabled ? 'Enabled' : 'Revoked';
      statusTd.appendChild(pill);
      tr.appendChild(statusTd);

      var createdTd = document.createElement('td');
      createdTd.textContent = fmtDate(device.createdAt);
      tr.appendChild(createdTd);

      var lastSeenTd = document.createElement('td');
      lastSeenTd.textContent = fmtDate(device.lastSeenAt);
      tr.appendChild(lastSeenTd);

      var actionsTd = document.createElement('td');
      actionsTd.className = 'row-actions';

      var toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-secondary';
      toggleBtn.textContent = device.enabled ? 'Revoke' : 'Re-enable';
      toggleBtn.addEventListener('click', function () {
        api('PATCH', '/api/workflow/devices/' + encodeURIComponent(device.id), { enabled: !device.enabled })
          .then(function (r) {
            if (!r.ok) return showDevicesError(r.data.error || 'Could not update device');
            loadDevices();
          });
      });
      actionsTd.appendChild(toggleBtn);

      var deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-icon';
      deleteBtn.title = 'Delete device';
      deleteBtn.textContent = String.fromCharCode(0x1F5D1);
      deleteBtn.addEventListener('click', function () {
        if (!confirm('Delete "' + device.label + '"? This cannot be undone.')) return;
        api('DELETE', '/api/workflow/devices/' + encodeURIComponent(device.id))
          .then(function (r) {
            if (!r.ok) return showDevicesError(r.data.error || 'Could not delete device');
            loadDevices();
          });
      });
      actionsTd.appendChild(deleteBtn);

      tr.appendChild(actionsTd);
      body.appendChild(tr);
    });
  }

  function loadDevices() {
    api('GET', '/api/workflow/devices').then(function (r) {
      if (!r.ok) return showDevicesError(r.data.error || 'Could not load devices');
      renderDevices(r.data.devices || []);
    });
  }

  // ---- Auto-dismiss the pairing banner once the TV actually connects ----
  // "lastSeenAt" only gets set once a device makes its first real request
  // (i.e. it typed the code and submitted) - poll for that instead of
  // making the admin remember to close the banner by hand.
  var pairingWatchTimer = null;
  var pairingWatchDeviceId = '';
  var pairingWatchAttempts = 0;
  var PAIRING_WATCH_MAX_ATTEMPTS = 150; // ~10 minutes at 4s each

  function stopPairingWatch() {
    if (pairingWatchTimer) {
      clearInterval(pairingWatchTimer);
      pairingWatchTimer = null;
    }
    pairingWatchDeviceId = '';
    pairingWatchAttempts = 0;
  }

  function startPairingWatch(deviceId) {
    stopPairingWatch();
    pairingWatchDeviceId = deviceId;
    pairingWatchTimer = setInterval(function () {
      pairingWatchAttempts += 1;
      if (pairingWatchAttempts > PAIRING_WATCH_MAX_ATTEMPTS) {
        stopPairingWatch();
        return;
      }
      api('GET', '/api/workflow/devices').then(function (r) {
        if (!r.ok) return;
        var devices = r.data.devices || [];
        renderDevices(devices);
        var match = devices.find ? devices.find(function (d) { return d.id === pairingWatchDeviceId; }) : null;
        if (match && match.lastSeenAt) {
          document.getElementById('token-banner').classList.add('hidden');
          stopPairingWatch();
        }
      });
    }, 4000);
  }

  document.getElementById('add-device-btn').addEventListener('click', function () {
    var input = document.getElementById('new-device-label');
    var label = input.value.trim();
    showDevicesError('');
    api('POST', '/api/workflow/devices', { label: label }).then(function (r) {
      if (!r.ok) return showDevicesError(r.data.error || 'Could not create device');
      input.value = '';
      var banner = document.getElementById('token-banner');
      document.getElementById('token-banner-label').textContent = r.data.device.label;
      document.getElementById('token-banner-value').textContent = r.data.device.token;
      banner.classList.remove('hidden');
      populateHowTo();
      loadDevices();
      startPairingWatch(r.data.device.id);
    });
  });

  document.getElementById('token-banner-dismiss').addEventListener('click', function () {
    document.getElementById('token-banner').classList.add('hidden');
    stopPairingWatch();
  });

  var howtoCopyBtn = document.getElementById('howto-url-copy');
  if (howtoCopyBtn) {
    howtoCopyBtn.addEventListener('click', function () {
      var restoreLabel = howtoCopyBtn.textContent;
      var done = function () {
        howtoCopyBtn.textContent = 'Copied';
        setTimeout(function () { howtoCopyBtn.textContent = restoreLabel; }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(currentDashboardUrl).then(done, done);
      } else {
        done();
      }
    });
  }

  // ---- Login ----

  document.getElementById('login-submit').addEventListener('click', function () {
    var username = document.getElementById('login-username').value.trim();
    var password = document.getElementById('login-password').value;
    var errorEl = document.getElementById('login-error');
    errorEl.textContent = '';
    api('POST', '/api/admin/login', { username: username, password: password }).then(function (r) {
      if (!r.ok) {
        errorEl.textContent = r.data.error || 'Login failed';
        return;
      }
      if (r.data.mustChangePassword) {
        document.getElementById('cpw-cancel').classList.add('hidden');
        showOnly(cpwView);
      } else {
        enterShell(username);
      }
    });
  });

  ['login-username', 'login-password'].forEach(function (id) {
    document.getElementById(id).addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('login-submit').click();
    });
  });

  // ---- Forced first-login password change ----

  document.getElementById('cpw-submit').addEventListener('click', function () {
    var currentPassword = document.getElementById('cpw-current').value;
    var newPassword = document.getElementById('cpw-new').value;
    var errorEl = document.getElementById('cpw-error');
    errorEl.textContent = '';
    api('POST', '/api/admin/change-password', { currentPassword: currentPassword, newPassword: newPassword }).then(function (r) {
      if (!r.ok) {
        errorEl.textContent = r.data.error || 'Could not change password';
        return;
      }
      document.getElementById('cpw-current').value = '';
      document.getElementById('cpw-new').value = '';
      enterShell();
    });
  });

  document.getElementById('cpw-cancel').addEventListener('click', function () {
    enterShell();
  });

  // ---- Account (change password, once already signed in) ----

  document.getElementById('account-submit').addEventListener('click', function () {
    var currentPassword = document.getElementById('account-current').value;
    var newPassword = document.getElementById('account-new').value;
    var errorEl = document.getElementById('account-error');
    var successEl = document.getElementById('account-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');
    api('POST', '/api/admin/change-password', { currentPassword: currentPassword, newPassword: newPassword }).then(function (r) {
      if (!r.ok) {
        errorEl.textContent = r.data.error || 'Could not change password';
        errorEl.classList.remove('hidden');
        return;
      }
      document.getElementById('account-current').value = '';
      document.getElementById('account-new').value = '';
      successEl.textContent = 'Password updated.';
      successEl.classList.remove('hidden');
    });
  });

  // ---- Logout ----

  document.getElementById('logout-btn').addEventListener('click', function () {
    api('POST', '/api/admin/logout').then(function () {
      window.location.reload();
    });
  });

  // ---- Entry ----

  function enterShell(username) {
    if (username) document.getElementById('sidebar-username').textContent = username;
    showOnly(shell);
    showView('overview');
  }

  api('GET', '/api/admin/session').then(function (r) {
    var session = r.data || {};
    if (!session.loggedIn) {
      showOnly(loginView);
      return;
    }
    if (session.mustChangePassword) {
      document.getElementById('cpw-cancel').classList.add('hidden');
      showOnly(cpwView);
      return;
    }
    enterShell(session.username);
  });
})();
