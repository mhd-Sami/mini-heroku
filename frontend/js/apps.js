const API_BASE = window.location.origin;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${wsProtocol}//${window.location.host}`;

let deployments = [];
let statsIntervals = {};
let logSocket = null;
let activeLogApp = null;

const emptyState = document.getElementById('empty-state');
const loadingState = document.getElementById('loading-state');
const appsGrid = document.getElementById('apps-grid');
const logsModal = document.getElementById('logs-modal');
const modalAppTitle = document.getElementById('modal-app-title');
const terminalConsole = document.getElementById('terminal-console');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnModalClear = document.getElementById('btn-modal-clear');
const btnModalCopy = document.getElementById('btn-modal-copy');

async function fetchDeployments() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps`);
    if (!res.ok) throw new Error('Failed to load deployments');
    deployments = await res.json();
    localStorage.setItem('mini_heroku_deployments_cache', JSON.stringify(deployments));
    renderDashboard();
  } catch (err) {
    console.error('Error fetching deployments:', err);
    if (loadingState) loadingState.classList.add('hidden');
    if (deployments.length === 0) {
      emptyState.classList.remove('hidden');
    }
  }
}

function renderDashboard() {
  if (loadingState) loadingState.classList.add('hidden');

  if (deployments.length === 0) {
    emptyState.classList.remove('hidden');
    appsGrid.classList.add('hidden');
    clearAllStatsPolling();
    return;
  }

  emptyState.classList.add('hidden');
  appsGrid.classList.remove('hidden');

  const runningAppNames = [];
  appsGrid.innerHTML = '';

  deployments.forEach(app => {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.id = `app-card-${app.app_name}`;

    const dateStr = new Date(app.created_at).toLocaleString();
    if (app.status === 'running') {
      runningAppNames.push(app.app_name);
    }

    card.innerHTML = `
      <div class="app-card-header">
        <div class="app-card-title-group">
          <span class="app-card-title" style="cursor: pointer;" title="Click to view configuration and logs">${app.app_name}</span>
          <span class="app-card-domain">
            <a href="${app.local_domain}" target="_blank">${app.app_name}.localhost</a>
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
        <div><strong>Created:</strong> ${dateStr}</div>
      </div>

      <div class="app-actions">
        <button class="btn btn-secondary btn-sm btn-details">Details</button>
        <button class="btn btn-secondary btn-sm btn-logs">Logs</button>
        <button class="btn btn-secondary btn-sm btn-start" ${app.status === 'running' ? 'disabled' : ''}>Start</button>
        <button class="btn btn-secondary btn-sm btn-stop" ${app.status !== 'running' ? 'disabled' : ''}>Stop</button>
        <button class="btn btn-danger-outline btn-sm btn-delete">Delete</button>
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

    appsGrid.appendChild(card);
  });

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
function syncStatsPolling(runningApps) {
  Object.keys(statsIntervals).forEach(appName => {
    if (!runningApps.includes(appName)) {
      clearInterval(statsIntervals[appName]);
      delete statsIntervals[appName];
    }
  });

  runningApps.forEach(appName => {
    if (!statsIntervals[appName]) {
      pollAppStats(appName);
      statsIntervals[appName] = setInterval(() => pollAppStats(appName), 3000);
    }
  });
}

function clearAllStatsPolling() {
  Object.keys(statsIntervals).forEach(appName => {
    clearInterval(statsIntervals[appName]);
  });
  statsIntervals = {};
}

async function pollAppStats(appName) {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/stats`);
    if (!res.ok) return;
    const data = await res.json();

    const cpuVal = document.getElementById(`cpu-val-${appName}`);
    const cpuBar = document.getElementById(`cpu-bar-${appName}`);
    const memVal = document.getElementById(`mem-val-${appName}`);
    const memBar = document.getElementById(`mem-bar-${appName}`);

    if (data.status === 'running') {
      if (cpuVal) cpuVal.textContent = `${data.cpu_percent}%`;
      if (cpuBar) {
        cpuBar.style.width = `${Math.min(data.cpu_percent, 100)}%`;
        setBarColor(cpuBar, data.cpu_percent);
      }
      if (memVal) memVal.textContent = `${data.memory_usage_mb}MB / ${data.memory_limit_mb}MB`;
      if (memBar) {
        memBar.style.width = `${data.memory_percent}%`;
        setBarColor(memBar, data.memory_percent);
      }
    } else {
      clearInterval(statsIntervals[appName]);
      delete statsIntervals[appName];
      fetchDeployments();
    }
  } catch (err) {
    console.error(`Stats error for ${appName}:`, err);
  }
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
