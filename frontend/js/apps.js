const API_BASE = window.location.origin;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${wsProtocol}//${window.location.host}`;

let deployments = [];
let statsIntervals = {};
let logSocket = null;
let activeLogApp = null;

// Search/Filter state
let searchFilter = '';
let statusFilter = 'all';
let appStatsCache = (function() {
  try {
    const cached = localStorage.getItem('mini_heroku_stats_cache');
    return cached ? JSON.parse(cached) : {};
  } catch (e) {
    return {};
  }
})(); // Cache stats for aggregate telemetry bar
let activeTab = 'active'; // 'active' or 'history'

const emptyState = document.getElementById('empty-state');
const loadingState = document.getElementById('loading-state');
const appsGrid = document.getElementById('apps-grid');
const logsModal = document.getElementById('logs-modal');
const modalAppTitle = document.getElementById('modal-app-title');
const terminalConsole = document.getElementById('terminal-console');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnModalClear = document.getElementById('btn-modal-clear');
const btnModalCopy = document.getElementById('btn-modal-copy');

const tabActive = document.getElementById('tab-active');
const tabHistory = document.getElementById('tab-history');
const activeDeploymentsView = document.getElementById('active-deployments-view');
const historyView = document.getElementById('history-view');
const historyTableBody = document.getElementById('history-table-body');
const historyEmptyState = document.getElementById('history-empty-state');
const btnClearHistory = document.getElementById('btn-clear-history');
const historyTableWrapper = document.getElementById('history-table-wrapper');

async function fetchDeployments() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps`);
    if (!res.ok) throw new Error('Failed to load deployments');
    const nextDeployments = await res.json();

    // Check for auto-deploy transitions
    if (deployments && deployments.length > 0) {
      nextDeployments.forEach(newApp => {
        const oldApp = deployments.find(d => d.app_name === newApp.app_name);
        if (oldApp) {
          if (oldApp.status !== 'building' && newApp.status === 'building' && newApp.auto_deploy) {
            showToastNotification(`New changes pushed for '${newApp.app_name}'. New deployment in progress...`);
          }
        }
      });
    }

    deployments = nextDeployments;
    localStorage.setItem('mini_heroku_deployments_cache', JSON.stringify(deployments));
    if (window.refreshNavBadge) {
      window.refreshNavBadge();
    }
    renderDashboard();
    updateTelemetryBar();
  } catch (err) {
    console.error('Error fetching deployments:', err);
    if (loadingState) loadingState.classList.add('hidden');
    if (deployments.length === 0) {
      emptyState.classList.remove('hidden');
    }
  }
}

function renderDashboard() {
  if (activeTab !== 'active') return;
  if (loadingState) loadingState.classList.add('hidden');

  if (deployments.length === 0) {
    emptyState.classList.remove('hidden');
    appsGrid.classList.add('hidden');
    clearAllStatsPolling();
    return;
  }

  emptyState.classList.add('hidden');
  
  // Apply Search and Status Filters
  const filtered = deployments.filter(app => {
    const matchesSearch = app.app_name.includes(searchFilter.toLowerCase().trim());
    const matchesStatus = statusFilter === 'all' || app.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  // Handle filter-empty state
  let searchEmpty = document.getElementById('search-empty-state');
  if (filtered.length === 0) {
    appsGrid.classList.add('hidden');
    if (!searchEmpty) {
      searchEmpty = document.createElement('div');
      searchEmpty.id = 'search-empty-state';
      searchEmpty.className = 'empty-state';
      searchEmpty.innerHTML = `
        <h3>No matching deployments</h3>
        <p>No active services match the specified name or status filter.</p>
      `;
      appsGrid.parentNode.insertBefore(searchEmpty, appsGrid.nextSibling);
    } else {
      searchEmpty.classList.remove('hidden');
    }
    clearAllStatsPolling();
    return;
  }

  if (searchEmpty) searchEmpty.classList.add('hidden');
  appsGrid.classList.remove('hidden');

  const runningAppNames = [];
  appsGrid.innerHTML = '';

  filtered.forEach(app => {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.id = `app-card-${app.app_name}`;

    const lastDeployDateStr = new Date(app.updated_at || app.created_at).toLocaleString();
    let alertBanner = '';
    if (app.status === 'building') {
      alertBanner = `
        <div class="card-alert-banner" style="margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem; padding: 0.5rem; border-radius: var(--radius-sm); border: 1px solid rgba(37, 99, 235, 0.15); background-color: rgba(37, 99, 235, 0.05); color: var(--color-info); font-size: 0.78rem; font-weight: 600;">
          <span class="btn-spinner" style="border-top-color: currentColor; width: 10px; height: 10px; border-width: 1.5px; margin: 0;"></span>
          <span>New changes pushed. Deployment in progress...</span>
        </div>
      `;
    }
    if (app.status === 'running') {
      runningAppNames.push(app.app_name);
    }

    card.innerHTML = `
      <div class="app-card-header">
        <div class="app-card-title-group">
          <span class="app-card-title" style="cursor: pointer;" title="Click to view configuration and logs">${app.app_name}</span>
          <span class="app-card-domain">
            <a href="${app.local_domain}" target="_blank">${app.app_name}.localhost</a>
            <button type="button" class="btn-copy-link" data-url="http://${app.app_name}.localhost" title="Copy Address">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
            </button>
          </span>
        </div>
        <span class="status-badge ${app.status}">
          <span class="pulse-dot"></span>
          <span class="status-text">${app.status}</span>
        </span>
      </div>

      <div class="app-stats">
        <div class="stat-row">
          <div class="stat-label-group">
            <span class="stat-name">CPU Usage</span>
            <span class="stat-val" id="cpu-val-${app.app_name}">--</span>
          </div>
          <div class="stat-bar-track">
            <div class="stat-bar-fill" id="cpu-bar-${app.app_name}" style="width: 0%"></div>
          </div>
        </div>

        <div class="stat-row">
          <div class="stat-label-group">
            <span class="stat-name">Memory</span>
            <span class="stat-val" id="mem-val-${app.app_name}">--</span>
          </div>
          <div class="stat-bar-track">
            <div class="stat-bar-fill" id="mem-bar-${app.app_name}" style="width: 0%"></div>
          </div>
        </div>
      </div>

      <div class="app-meta">
        <div><strong>Source:</strong> ${app.git_url}</div>
        <div><strong>Last Deploy:</strong> ${lastDeployDateStr}</div>
        <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 0.25rem; margin-bottom: 0.25rem;">
          <strong>Auto-Deploy:</strong>
          <span><input type="checkbox" class="card-auto-deploy" ${app.auto_deploy ? 'checked' : ''} style="cursor: pointer; transform: scale(1.1); vertical-align: middle;"></span>
        </div>
        
        <div class="meta-badges-row">
          ${app.last_commit_hash ? `
            <span class="badge-tag badge-git" title="Last Deployed Commit">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="git-icon"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              ${app.last_commit_hash.substring(0, 7)}
            </span>
          ` : ''}
          ${app.auto_deploy ? `
            <span class="badge-tag badge-auto-deploy-tag pulsing-dot-tag" title="Auto-Deploy Active">
              Auto-Deploy
            </span>
          ` : ''}
        </div>
        ${alertBanner}
      </div>

      <div class="app-actions">
        <button class="btn btn-secondary btn-sm btn-details">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          Details
        </button>
        <button class="btn btn-secondary btn-sm btn-logs">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          Logs
        </button>
        <button class="btn btn-secondary btn-sm btn-start" ${app.status === 'running' ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start
        </button>
        <button class="btn btn-secondary btn-sm btn-stop" ${app.status !== 'running' ? 'disabled' : ''}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>
          Stop
        </button>
        <button class="btn btn-danger-outline btn-sm btn-delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          Delete
        </button>
      </div>
    `;

    // Dynamic bindings
    card.querySelector('.app-card-title').addEventListener('click', () => {
      window.location.href = `app-details.html?app=${app.app_name}`;
    });
    card.querySelector('.btn-details').addEventListener('click', () => {
      window.location.href = `app-details.html?app=${app.app_name}`;
    });
    card.querySelector('.btn-logs').addEventListener('click', () => {
      showLogs(app.app_name);
    });
    card.querySelector('.btn-start').addEventListener('click', (e) => startApp(app.app_name, e.currentTarget));
    card.querySelector('.btn-stop').addEventListener('click', (e) => stopApp(app.app_name, e.currentTarget));
    card.querySelector('.btn-delete').addEventListener('click', (e) => deleteApp(app.app_name, e.currentTarget));

    card.querySelector('.btn-copy-link').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      const url = btn.getAttribute('data-url');
      navigator.clipboard.writeText(url).then(() => {
        btn.classList.add('copied');
        btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>`;
        }, 1500);
      });
    });

    card.querySelector('.card-auto-deploy').addEventListener('change', async (e) => {
      const enabled = e.currentTarget.checked;
      try {
        const res = await authFetch(`${API_BASE}/api/apps/${app.app_name}/auto-deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        if (!res.ok) throw new Error("Failed to update auto-deploy settings");
        const result = await res.json();
        console.log(`Auto-deploy setting for ${app.app_name} updated to:`, result.auto_deploy);
        fetchDeployments();
      } catch (err) {
        alert(err.message);
        e.currentTarget.checked = !enabled;
      }
    });

    appsGrid.appendChild(card);
  });

  applyCachedStatsToDOM();
  syncStatsPolling(runningAppNames);
}

// Actions
async function startApp(appName, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> Starting...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/start`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to start application');
    fetchDeployments();
  } catch (err) {
    alert(`Error starting app: ${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Start';
    }
  }
}

async function stopApp(appName, btn) {
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> Stopping...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to stop application');
    fetchDeployments();
  } catch (err) {
    alert(`Error stopping app: ${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Stop';
    }
  }
}

async function deleteApp(appName, btn) {
  if (!confirm(`Are you sure you want to delete ${appName}? This will permanently remove the container and image.`)) {
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="btn-spinner"></span> Deleting...`;
  }
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to delete application');
    fetchDeployments();
  } catch (err) {
    alert(`Error deleting app: ${err.message}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Delete';
    }
  }
}

// Polling
let bulkStatsInterval = null;

function syncStatsPolling(runningApps) {
  if (runningApps.length > 0) {
    if (!bulkStatsInterval) {
      pollBulkStats();
      bulkStatsInterval = setInterval(pollBulkStats, 3000);
    }
  } else {
    if (bulkStatsInterval) {
      clearInterval(bulkStatsInterval);
      bulkStatsInterval = null;
    }
  }
}

function clearAllStatsPolling() {
  if (bulkStatsInterval) {
    clearInterval(bulkStatsInterval);
    bulkStatsInterval = null;
  }
}

async function pollBulkStats() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/stats/bulk`);
    if (!res.ok) throw new Error('Failed to fetch bulk stats');
    const bulkData = await res.json();

    let statusChanged = false;

    // Check if any app in our current deployments list has a changed status
    deployments.forEach(app => {
      if (app.status === 'running') {
        const stats = bulkData[app.app_name];
        if (!stats || stats.status !== 'running') {
          statusChanged = true;
          delete appStatsCache[app.app_name];
        } else {
          appStatsCache[app.app_name] = stats;
          updateAppStatsUI(app.app_name, stats);
        }
      }
    });

    localStorage.setItem('mini_heroku_stats_cache', JSON.stringify(appStatsCache));
    updateTelemetryBar();

    if (statusChanged) {
      fetchDeployments();
    }
  } catch (err) {
    console.error('Error polling bulk stats:', err);
  }
}

function updateAppStatsUI(appName, stats) {
  const cpuVal = document.getElementById(`cpu-val-${appName}`);
  const cpuBar = document.getElementById(`cpu-bar-${appName}`);
  const memVal = document.getElementById(`mem-val-${appName}`);
  const memBar = document.getElementById(`mem-bar-${appName}`);

  if (cpuVal) cpuVal.textContent = `${stats.cpu_percent}%`;
  if (cpuBar) {
    cpuBar.style.width = `${Math.min(stats.cpu_percent, 100)}%`;
    setBarColor(cpuBar, stats.cpu_percent);
  }
  if (memVal) memVal.textContent = `${stats.memory_usage_mb}MB / ${stats.memory_limit_mb}MB`;
  if (memBar) {
    memBar.style.width = `${stats.memory_percent}%`;
    setBarColor(memBar, stats.memory_percent);
  }
}

function applyCachedStatsToDOM() {
  deployments.forEach(app => {
    if (app.status === 'running' && appStatsCache[app.app_name]) {
      const stats = appStatsCache[app.app_name];
      updateAppStatsUI(app.app_name, stats);
    }
  });
}

function setBarColor(barElement, percentage) {
  barElement.classList.remove('warning', 'danger');
  if (percentage >= 85) {
    barElement.classList.add('danger');
  } else if (percentage >= 70) {
    barElement.classList.add('warning');
  }
}

/* ==========================================================================
   Logs Modal Websocket Client Logic
   ========================================================================== */

function showLogs(appName) {
  activeLogApp = appName;
  modalAppTitle.textContent = `Deployment Console: ${appName}`;
  terminalConsole.innerHTML = '';
  
  if (logSocket) {
    logSocket.close();
  }

  logsModal.classList.add('active');
  logsModal.setAttribute('aria-hidden', 'false');

  const token = localStorage.getItem('mini_heroku_token');
  const socketUrl = `${WS_BASE}/ws/logs/${appName}?token=${encodeURIComponent(token || '')}`;
  logSocket = new WebSocket(socketUrl);

  logSocket.onmessage = (event) => {
    appendTerminalLine(event.data);
  };

  logSocket.onerror = (err) => {
    appendTerminalLine(`[UI-CLIENT] WebSocket connection error: ${err}`);
  };

  logSocket.onclose = () => {
    appendTerminalLine(`[UI-CLIENT] WebSocket connection disconnected.`);
  };
}

function appendTerminalLine(text) {
  const line = document.createElement('div');
  line.textContent = text;
  
  if (text.startsWith('---') || text.includes('Successfully deployed!')) {
    line.style.color = '#38bdf8';
    line.style.fontWeight = 'bold';
  } else if (text.startsWith('Deployment ERROR:') || text.startsWith('[container] ERROR')) {
    line.style.color = '#ef4444';
  } else if (text.startsWith('[UI-CLIENT]')) {
    line.style.color = '#64748b';
  } else if (text.startsWith('[container]')) {
    line.style.color = '#cbd5e1';
  } else {
    line.style.color = '#10b981';
  }

  terminalConsole.appendChild(line);
  terminalConsole.scrollTop = terminalConsole.scrollHeight;
}

function closeModal() {
  logsModal.classList.remove('active');
  logsModal.setAttribute('aria-hidden', 'true');
  if (logSocket) {
    logSocket.close();
    logSocket = null;
  }
  activeLogApp = null;
  fetchDeployments();
}

if (btnCloseModal) btnCloseModal.addEventListener('click', closeModal);
const modalBackdrop = document.querySelector('.modal-backdrop');
if (modalBackdrop) modalBackdrop.addEventListener('click', closeModal);

if (btnModalClear) {
  btnModalClear.addEventListener('click', () => {
    terminalConsole.innerHTML = '';
  });
}

if (btnModalCopy) {
  btnModalCopy.addEventListener('click', () => {
    const logLines = Array.from(terminalConsole.children).map(child => child.textContent);
    const fullLog = logLines.join('\n');
    
    navigator.clipboard.writeText(fullLog).then(() => {
      const originalText = btnModalCopy.textContent;
      btnModalCopy.textContent = 'Copied!';
      btnModalCopy.style.borderColor = 'var(--color-success)';
      btnModalCopy.style.color = 'var(--color-success)';
      setTimeout(() => {
        btnModalCopy.textContent = originalText;
        btnModalCopy.style.borderColor = '';
        btnModalCopy.style.color = '';
      }, 2000);
    }).catch(err => {
      console.error('Could not copy logs: ', err);
    });
  });
}

// Initial load
function loadCachedDeployments() {
  const cached = localStorage.getItem('mini_heroku_deployments_cache');
  if (cached) {
    try {
      deployments = JSON.parse(cached);
      if (deployments && deployments.length > 0) {
        renderDashboard();
      }
    } catch (e) {
      console.error("Failed to parse cached deployments:", e);
    }
  }
}
loadCachedDeployments();
fetchDeployments();
setInterval(fetchDeployments, 5000); // Poll deployments list every 5 seconds to detect auto-deployments

// Parse query params to launch logs modal if a deployment is in progress
function checkDeployingParam() {
  const urlParams = new URLSearchParams(window.location.search);
  const deployingApp = urlParams.get('deploying');
  if (deployingApp) {
    showLogs(deployingApp);
    // Clear URL parameters without reloading
    const newUrl = window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);
  }
}
checkDeployingParam();

function showToastNotification(message) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.style.cssText = 'position: fixed; bottom: 2rem; right: 2rem; display: flex; flex-direction: column; gap: 0.75rem; z-index: 9999; pointer-events: none;';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast-alert';
  toast.style.cssText = 'background: var(--color-primary); color: var(--color-text-light); border: 1px solid var(--color-bg-alt); padding: 0.8rem 1.2rem; border-radius: var(--radius-sm); box-shadow: var(--shadow-lg); font-size: 0.85rem; font-weight: 600; min-width: 300px; backdrop-filter: blur(8px); animation: toastIn 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; pointer-events: auto;';
  toast.innerHTML = `
    <div style="display: flex; align-items: center; gap: 0.6rem;">
      <span class="btn-spinner" style="border-top-color: var(--color-text-light); width: 12px; height: 12px; border-width: 1.5px; margin: 0;"></span>
      <span>${message}</span>
    </div>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toastOut 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards';
    setTimeout(() => toast.remove(), 300);
  }, 6000);
}

// Telemetry aggregator updates
function updateTelemetryBar() {
  const totalApps = deployments.length;
  const runningApps = deployments.filter(d => d.status === 'running').length;
  
  const elTotalApps = document.getElementById('telemetry-total-apps');
  const elRunningApps = document.getElementById('telemetry-running-apps');
  const elTotalCpu = document.getElementById('telemetry-total-cpu');
  const elTotalMem = document.getElementById('telemetry-total-mem');

  if (elTotalApps) elTotalApps.textContent = totalApps;
  if (elRunningApps) elRunningApps.textContent = runningApps;
  
  let totalCpu = 0.0;
  let totalMem = 0.0;
  Object.keys(appStatsCache).forEach(app => {
    const cpuVal = appStatsCache[app].cpu_percent !== undefined ? appStatsCache[app].cpu_percent : (appStatsCache[app].cpu || 0.0);
    const memVal = appStatsCache[app].memory_usage_mb !== undefined ? appStatsCache[app].memory_usage_mb : (appStatsCache[app].mem || 0.0);
    totalCpu += cpuVal;
    totalMem += memVal;
  });
  
  if (elTotalCpu) elTotalCpu.textContent = `${totalCpu.toFixed(1)}%`;
  if (elTotalMem) elTotalMem.textContent = `${totalMem.toFixed(0)} MB`;
}

// Bind search and filter events
function setupFilters() {
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      searchFilter = e.target.value;
      renderDashboard();
    });
  }

  const filterGroup = document.getElementById('filter-group');
  if (filterGroup) {
    filterGroup.querySelectorAll('.filter-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        filterGroup.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        statusFilter = btn.getAttribute('data-status');
        renderDashboard();
      });
    });
  }
}
setupFilters();

/* ==========================================================================
   Deployment History Log Logic
   ========================================================================== */

async function loadHistory() {
  try {
    const res = await authFetch(`${API_BASE}/api/deployments/history`);
    if (!res.ok) throw new Error('Failed to load deployment history');
    const history = await res.json();
    renderHistory(history);
  } catch (err) {
    console.error('Error fetching deployment history:', err);
    if (historyTableWrapper) historyTableWrapper.classList.add('hidden');
    if (btnClearHistory) btnClearHistory.style.display = 'none';
    if (historyEmptyState) historyEmptyState.classList.remove('hidden');
  }
}

function renderHistory(history) {
  if (!historyTableBody) return;
  historyTableBody.innerHTML = '';

  if (history.length === 0) {
    if (historyTableWrapper) historyTableWrapper.classList.add('hidden');
    if (btnClearHistory) btnClearHistory.style.display = 'none';
    if (historyEmptyState) historyEmptyState.classList.remove('hidden');
    return;
  }

  if (historyTableWrapper) historyTableWrapper.classList.remove('hidden');
  if (btnClearHistory) btnClearHistory.style.display = 'block';
  if (historyEmptyState) historyEmptyState.classList.add('hidden');

  history.forEach(item => {
    const tr = document.createElement('tr');
    const dateStr = new Date(item.deployed_at).toLocaleString();
    const commitHash = item.last_commit_hash 
      ? `<code style="font-family: var(--font-family-mono); font-size: 0.78rem; background-color: var(--color-bg-cream); padding: 0.2rem 0.4rem; border-radius: var(--radius-sm); color: var(--color-primary-light);">${item.last_commit_hash.substring(0, 7)}</code>`
      : '<span style="color: var(--color-text-muted);">--</span>';

    let badgeClass = 'stopped';
    if (item.status === 'success') badgeClass = 'running';
    if (item.status === 'failed') badgeClass = 'failed';

    const statusBadge = `
      <span class="status-badge ${badgeClass}" style="padding: 0.15rem 0.6rem; font-size: 0.72rem;">
        <span class="pulse-dot"></span>
        <span class="status-text">${item.status === 'success' ? 'SUCCESS' : 'FAILED'}</span>
      </span>
    `;

    tr.innerHTML = `
      <td style="font-weight: 600; color: var(--color-text-main);">${item.app_name}</td>
      <td style="color: var(--color-text-muted); font-size: 0.78rem; max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${item.git_url}">${item.git_url}</td>
      <td>${statusBadge}</td>
      <td>${commitHash}</td>
      <td style="color: var(--color-text-muted); font-size: 0.78rem;">${dateStr}</td>
      <td style="text-align: right; padding-right: 1.5rem;">
        <button class="btn-delete-history" data-id="${item.id}" title="Remove entry">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </td>
    `;

    tr.querySelector('.btn-delete-history').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const historyId = btn.getAttribute('data-id');
      btn.disabled = true;
      try {
        const res = await authFetch(`${API_BASE}/api/deployments/history/${historyId}`, {
          method: 'DELETE'
        });
        if (!res.ok) throw new Error('Failed to delete history item');
        tr.remove();
        loadHistory();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });

    historyTableBody.appendChild(tr);
  });
}

// Bind tabs switching events
if (tabActive && tabHistory) {
  tabActive.addEventListener('click', () => {
    if (activeTab === 'active') return;
    activeTab = 'active';
    tabActive.classList.add('active');
    tabHistory.classList.remove('active');
    activeDeploymentsView.classList.remove('hidden');
    historyView.classList.add('hidden');
    fetchDeployments();
  });

  tabHistory.addEventListener('click', () => {
    if (activeTab === 'history') return;
    activeTab = 'history';
    tabHistory.classList.add('active');
    tabActive.classList.remove('active');
    activeDeploymentsView.classList.add('hidden');
    historyView.classList.remove('hidden');
    loadHistory();
  });
}

// Bind clear history action
if (btnClearHistory) {
  btnClearHistory.addEventListener('click', async () => {
    if (!confirm('Are you sure you want to clear your deployment history? This cannot be undone.')) {
      return;
    }
    btnClearHistory.disabled = true;
    try {
      const res = await authFetch(`${API_BASE}/api/deployments/history`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to clear history');
      loadHistory();
    } catch (err) {
      alert(err.message);
    } finally {
      btnClearHistory.disabled = false;
    }
  });
}
