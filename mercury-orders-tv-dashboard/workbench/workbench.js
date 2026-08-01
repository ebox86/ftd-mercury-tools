(function () {
  var shell = document.getElementById('app-shell');

  // This page always lives at ".../workbench/" - whatever comes before that
  // in the current URL (nothing when hit directly on the bridge, "/Talaria"
  // when proxied through IIS, etc.) has to be prepended to every API call,
  // or requests miss any upstream reverse proxy and 404 at the site root.
  var sitePrefix = window.location.pathname.replace(/\/workbench\/?$/, '');

  var currentRole = '';
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
  // device - if that's what this page was opened with, ask the bridge for
  // its actual LAN-facing address(es) instead. Otherwise trust the host
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

  var dashboardUrlInfoPromise = api('GET', '/api/workbench/network-info').then(function (r) {
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

  // ---- Navigation (role-driven) ----

  var views = {
    overview: document.getElementById('view-overview'),
    devices: document.getElementById('view-devices'),
    users: document.getElementById('view-users'),
    picklist: document.getElementById('view-picklist'),
    orders: document.getElementById('view-orders'),
    account: document.getElementById('view-account'),
  };
  var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item'));

  function roleAllows(btn) {
    var roles = (btn.getAttribute('data-roles') || '').split(',');
    return roles.indexOf(currentRole) !== -1;
  }

  function applyRoleNav() {
    var firstVisible = '';
    navItems.forEach(function (btn) {
      var allowed = roleAllows(btn);
      btn.classList.toggle('hidden', !allowed);
      if (allowed && !firstVisible) firstVisible = btn.getAttribute('data-view');
    });
    var ordersNav = document.getElementById('nav-orders');
    var ordersTitle = document.getElementById('orders-title');
    var isMine = currentRole === 'designer';
    if (ordersNav) ordersNav.textContent = isMine ? 'My Orders' : 'Orders';
    if (ordersTitle) ordersTitle.textContent = isMine ? 'My Orders' : 'Orders';
    return firstVisible;
  }

  function showView(name) {
    Object.keys(views).forEach(function (key) {
      if (views[key]) views[key].classList.toggle('hidden', key !== name);
    });
    navItems.forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-view') === name);
    });
    if (name === 'overview') loadOverview();
    if (name === 'devices') loadDevices();
    if (name === 'users') loadUsers();
    if (name === 'orders') loadOrders();
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
  // button, rather than an always-editable input - resting a cursor in the
  // wrong cell and typing (or a stray click) used to silently rename the
  // device on blur.
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

  // ---- Users (admin only) ----

  var ROLE_LABELS = { admin: 'Admin', manager: 'Manager', designer: 'Designer', viewer: 'Viewer' };

  function showUsersError(message) {
    var el = document.getElementById('users-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function renderUserRow(user) {
    var tr = document.createElement('tr');

    var usernameTd = document.createElement('td');
    usernameTd.textContent = user.username;
    tr.appendChild(usernameTd);

    var roleTd = document.createElement('td');
    renderUserRoleDisplay(roleTd, user);
    tr.appendChild(roleTd);

    var labelTd = document.createElement('td');
    labelTd.textContent = user.label || '';
    tr.appendChild(labelTd);

    var statusTd = document.createElement('td');
    var pill = document.createElement('span');
    pill.className = 'pill ' + (user.enabled ? 'pill-on' : 'pill-off');
    pill.textContent = user.enabled ? 'Enabled' : 'Disabled';
    statusTd.appendChild(pill);
    tr.appendChild(statusTd);

    var lastLoginTd = document.createElement('td');
    lastLoginTd.textContent = fmtDate(user.lastLoginAt);
    tr.appendChild(lastLoginTd);

    var actionsTd = document.createElement('td');
    actionsTd.className = 'row-actions';

    var toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn btn-secondary';
    toggleBtn.textContent = user.enabled ? 'Disable' : 'Enable';
    toggleBtn.addEventListener('click', function () {
      api('PATCH', '/api/workbench/users/' + encodeURIComponent(user.id), { enabled: !user.enabled })
        .then(function (r) {
          if (!r.ok) return showUsersError(r.data.error || 'Could not update user');
          loadUsers();
        });
    });
    actionsTd.appendChild(toggleBtn);

    var resetBtn = document.createElement('button');
    resetBtn.className = 'btn btn-secondary';
    resetBtn.textContent = 'Reset password';
    resetBtn.addEventListener('click', function () {
      if (!confirm('Reset the password for "' + user.username + '"? A new temporary password will be shown once.')) return;
      api('PATCH', '/api/workbench/users/' + encodeURIComponent(user.id), { resetPassword: true })
        .then(function (r) {
          if (!r.ok) return showUsersError(r.data.error || 'Could not reset password');
          showUserTokenBanner(user.username, r.data.tempPassword);
          loadUsers();
        });
    });
    actionsTd.appendChild(resetBtn);

    var deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn btn-icon';
    deleteBtn.title = 'Delete user';
    deleteBtn.textContent = String.fromCharCode(0x1F5D1);
    deleteBtn.addEventListener('click', function () {
      if (!confirm('Delete "' + user.username + '"? This cannot be undone.')) return;
      api('DELETE', '/api/workbench/users/' + encodeURIComponent(user.id))
        .then(function (r) {
          if (!r.ok) return showUsersError(r.data.error || 'Could not delete user');
          loadUsers();
        });
    });
    actionsTd.appendChild(deleteBtn);

    tr.appendChild(actionsTd);
    return tr;
  }

  function renderUserRoleDisplay(roleTd, user) {
    roleTd.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'device-label-display';

    var pill = document.createElement('span');
    pill.className = 'pill pill-role';
    pill.textContent = ROLE_LABELS[user.role] || user.role;
    wrap.appendChild(pill);

    var editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn btn-icon device-label-edit-btn';
    editBtn.title = 'Change role';
    editBtn.textContent = String.fromCharCode(0x270e);
    editBtn.addEventListener('click', function () {
      renderUserRoleEditor(roleTd, user);
    });
    wrap.appendChild(editBtn);

    roleTd.appendChild(wrap);
  }

  function renderUserRoleEditor(roleTd, user) {
    roleTd.innerHTML = '';
    var wrap = document.createElement('div');
    wrap.className = 'device-label-edit-row';

    var select = document.createElement('select');
    Object.keys(ROLE_LABELS).forEach(function (role) {
      var option = document.createElement('option');
      option.value = role;
      option.textContent = ROLE_LABELS[role];
      if (role === user.role) option.selected = true;
      select.appendChild(option);
    });
    wrap.appendChild(select);

    var saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn-icon';
    saveBtn.title = 'Save role';
    saveBtn.textContent = String.fromCharCode(0x2713);
    wrap.appendChild(saveBtn);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'btn btn-icon';
    cancelBtn.title = 'Cancel';
    cancelBtn.textContent = String.fromCharCode(0x2715);
    wrap.appendChild(cancelBtn);

    saveBtn.addEventListener('click', function () {
      var newRole = select.value;
      if (newRole === user.role) {
        renderUserRoleDisplay(roleTd, user);
        return;
      }
      saveBtn.disabled = true;
      api('PATCH', '/api/workbench/users/' + encodeURIComponent(user.id), { role: newRole })
        .then(function (r) {
          if (!r.ok) {
            showUsersError(r.data.error || 'Could not change role');
            saveBtn.disabled = false;
            return;
          }
          user.role = newRole;
          renderUserRoleDisplay(roleTd, user);
        });
    });
    cancelBtn.addEventListener('click', function () { renderUserRoleDisplay(roleTd, user); });

    roleTd.appendChild(wrap);
  }

  function renderUsers(users) {
    var body = document.getElementById('users-body');
    body.innerHTML = '';
    if (!users.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="6" style="color:#8a91a6;">No users yet.</td>';
      body.appendChild(tr);
      return;
    }
    users.forEach(function (user) { body.appendChild(renderUserRow(user)); });
  }

  function loadUsers() {
    api('GET', '/api/workbench/users').then(function (r) {
      if (!r.ok) return showUsersError(r.data.error || 'Could not load users');
      renderUsers(r.data.users || []);
    });
  }

  function showUserTokenBanner(username, tempPassword) {
    var banner = document.getElementById('user-token-banner');
    document.getElementById('user-token-banner-label').textContent = username;
    document.getElementById('user-token-banner-value').textContent = tempPassword;
    banner.classList.remove('hidden');
  }

  document.getElementById('add-user-btn').addEventListener('click', function () {
    var usernameInput = document.getElementById('new-user-username');
    var roleSelect = document.getElementById('new-user-role');
    var labelInput = document.getElementById('new-user-label');
    var username = usernameInput.value.trim();
    var role = roleSelect.value;
    var label = labelInput.value.trim();
    showUsersError('');
    api('POST', '/api/workbench/users', { username: username, role: role, label: label }).then(function (r) {
      if (!r.ok) return showUsersError(r.data.error || 'Could not create user');
      usernameInput.value = '';
      labelInput.value = '';
      showUserTokenBanner(r.data.user.username, r.data.tempPassword);
      loadUsers();
    });
  });

  document.getElementById('user-token-banner-dismiss').addEventListener('click', function () {
    document.getElementById('user-token-banner').classList.add('hidden');
  });

  // ---- Orders / My Orders (manager, designer, viewer) ----

  function showOrdersError(message) {
    var el = document.getElementById('orders-error');
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function todayDateKey() {
    var now = new Date();
    var y = now.getFullYear();
    var m = String(now.getMonth() + 1).padStart(2, '0');
    var d = String(now.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function shiftDateKey(dateKey, deltaDays) {
    var parts = dateKey.split('-').map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    date.setDate(date.getDate() + deltaDays);
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function renderOrders(rows) {
    var body = document.getElementById('orders-body');
    body.innerHTML = '';
    if (!rows.length) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td colspan="5" style="color:#8a91a6;">No orders for this day.</td>';
      body.appendChild(tr);
      return;
    }
    rows.forEach(function (row) {
      var tr = document.createElement('tr');

      var orderTd = document.createElement('td');
      orderTd.textContent = row.USER_REFERENCE || row.ID || '--';
      tr.appendChild(orderTd);

      var recipientTd = document.createElement('td');
      recipientTd.textContent = row.RECIPIENT_NAME || row.CUSTOMER_NAME || '--';
      tr.appendChild(recipientTd);

      var addressTd = document.createElement('td');
      var addressParts = [row.RECIPIENT_ADDRESS, row.RECIPIENT_CITY, row.RECIPIENT_STATE_ABBREV, row.RECIPIENT_ZIP].filter(Boolean);
      addressTd.textContent = addressParts.join(', ') || '--';
      tr.appendChild(addressTd);

      var statusTd = document.createElement('td');
      statusTd.textContent = row.DELIVERY_STATUS || row.DESIGN_STATUS || row.STATUS || '--';
      tr.appendChild(statusTd);

      var dateTd = document.createElement('td');
      dateTd.textContent = row.DELIVERY_DATE || '--';
      tr.appendChild(dateTd);

      body.appendChild(tr);
    });
  }

  function loadOrders() {
    var dateInput = document.getElementById('orders-date');
    var dateKey = dateInput.value || todayDateKey();
    dateInput.value = dateKey;
    showOrdersError('');
    var query = '?fromDate=' + encodeURIComponent(dateKey) + '&toDate=' + encodeURIComponent(dateKey) + '&includeDelivered=true&notDelivered=false';
    api('GET', '/api/workflow/tickets/search' + query).then(function (r) {
      if (!r.ok) return showOrdersError(r.data.error || 'Could not load orders');
      renderOrders((r.data && r.data.rows) || []);
    });
  }

  document.getElementById('orders-date').addEventListener('change', loadOrders);
  document.getElementById('orders-prev-day').addEventListener('click', function () {
    var dateInput = document.getElementById('orders-date');
    dateInput.value = shiftDateKey(dateInput.value || todayDateKey(), -1);
    loadOrders();
  });
  document.getElementById('orders-next-day').addEventListener('click', function () {
    var dateInput = document.getElementById('orders-date');
    dateInput.value = shiftDateKey(dateInput.value || todayDateKey(), 1);
    loadOrders();
  });
  document.getElementById('orders-today').addEventListener('click', function () {
    document.getElementById('orders-date').value = todayDateKey();
    loadOrders();
  });

  // ---- Account (self-service password change, every role) ----

  document.getElementById('account-submit').addEventListener('click', function () {
    var currentPassword = document.getElementById('account-current').value;
    var newPassword = document.getElementById('account-new').value;
    var errorEl = document.getElementById('account-error');
    var successEl = document.getElementById('account-success');
    errorEl.classList.add('hidden');
    successEl.classList.add('hidden');
    api('POST', '/api/workbench/change-password', { currentPassword: currentPassword, newPassword: newPassword }).then(function (r) {
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
    api('POST', '/api/workbench/logout').then(function () {
      window.location.href = sitePrefix + '/';
    });
  });

  // ---- Entry ----
  // Workbench owns no login UI of its own - the site root is the single
  // login gate for the whole product. If there's no valid session (or the
  // account still needs a forced password change), bounce there instead.

  document.getElementById('sidebar-username').textContent = '';
  api('GET', '/api/workbench/session').then(function (r) {
    var session = r.data || {};
    if (!session.loggedIn || session.mustChangePassword) {
      window.location.href = sitePrefix + '/';
      return;
    }
    currentRole = session.role || '';
    document.getElementById('sidebar-username').textContent = session.label || session.username;
    var firstView = applyRoleNav();
    shell.classList.remove('hidden');
    if (firstView) showView(firstView);
  }).catch(function () {
    window.location.href = sitePrefix + '/';
  });
})();
