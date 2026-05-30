/* ==========================================================================
   MINI-HEROKU FRONTEND CORE LOGIC
   Handles dashboard interactions, API fetching, WebSocket logs, and stats polling.
   ========================================================================== */

// Configure base URLs dynamically based on location
const API_BASE = window.location.origin;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${wsProtocol}//${window.location.host}`;

// State Management
let deployments = [];
let statsIntervals = {};
let logSocket = null;
let activeLogApp = null;
let activeDetailsApp = null;
let detailsSocket = null;

// DOM Elements
const deployForm = document.getElementById('deploy-form');
const btnAddEnv = document.getElementById('btn-add-env');
const envList = document.getElementById('env-list');
const emptyState = document.getElementById('empty-state');
const appsGrid = document.getElementById('apps-grid');
const logsModal = document.getElementById('logs-modal');
const modalAppTitle = document.getElementById('modal-app-title');
const terminalConsole = document.getElementById('terminal-console');
const btnCloseModal = document.getElementById('btn-close-modal');
const btnModalClear = document.getElementById('btn-modal-clear');
const btnModalCopy = document.getElementById('btn-modal-copy');

const metricTotalApps = document.getElementById('metric-total-apps');
const metricRunningApps = document.getElementById('metric-running-apps');

const dashboardViewWrapper = document.getElementById('dashboard-view-wrapper');
const detailsView = document.getElementById('details-view');
const btnBackDashboard = document.getElementById('btn-back-dashboard');

const detailsAppName = document.getElementById('details-app-name');
const detailsAppLink = document.getElementById('details-app-link');
const detailsStatusBadge = document.getElementById('details-status-badge');
const detailsStatusText = document.getElementById('details-status-text');

const detailsCpuVal = document.getElementById('details-cpu-val');
const detailsCpuBar = document.getElementById('details-cpu-bar');
const detailsMemVal = document.getElementById('details-mem-val');
const detailsMemBar = document.getElementById('details-mem-bar');

const detailsGitUrl = document.getElementById('details-git-url');
const detailsPort = document.getElementById('details-port');
const detailsCpuLimit = document.getElementById('details-cpu-limit');
const detailsMemLimit = document.getElementById('details-mem-limit');
const detailsCreatedAt = document.getElementById('details-created-at');
const detailsEnvList = document.getElementById('details-env-list');
const detailsTerminal = document.getElementById('details-terminal');

const btnDetailsCopyLogs = document.getElementById('btn-details-copy-logs');
const btnDetailsRestart = document.getElementById('btn-details-restart');
const btnDetailsStop = document.getElementById('btn-details-stop');
const btnDetailsDelete = document.getElementById('btn-details-delete');

/* ==========================================================================
   Environment Variables Form Builder
   ========================================================================== */

// Add an environment variable input row
function addEnvRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input type="text" class="env-key" placeholder="KEY" value="${key}" required pattern="^[a-zA-Z_][a-zA-Z0-9_]*$" title="Valid env variable name (letters, numbers, underscores, starting with letter)">
    <input type="text" class="env-value" placeholder="value" value="${val}">
    <button type="button" class="btn-remove-env" title="Remove">&times;</button>
  `;
  
  // Attach remove action
  row.querySelector('.btn-remove-env').addEventListener('click', () => {
    row.remove();
  });
  
  envList.appendChild(row);
}

// Event listener for adding env rows
btnAddEnv.addEventListener('click', () => addEnvRow());

// Gather env variables from the form
function getEnvVariables() {
  const envVars = {};
  const rows = envList.querySelectorAll('.env-row');
  rows.forEach(row => {
    const key = row.querySelector('.env-key').value.trim();
    const val = row.querySelector('.env-value').value;
    if (key) {
      envVars[key] = val;
    }
  });
  return envVars;
}

/* ==========================================================================
   API Interactions & Renderers
   ========================================================================== */

// Fetch all deployed applications
async function fetchDeployments() {
  try {
    const res = await fetch(`${API_BASE}/api/apps`);
    if (!res.ok) throw new Error('Failed to load apps');
    deployments = await res.json();
    renderDashboard();
  } catch (err) {
    console.error('Error fetching deployments:', err);
  }
}

// Render metrics banner and application grid
function renderDashboard() {
  // Update totals
  metricTotalApps.textContent = deployments.length;
  const runningCount = deployments.filter(d => d.status === 'running').length;
  metricRunningApps.textContent = runningCount;

  if (deployments.length === 0) {
    emptyState.classList.remove('hidden');
    appsGrid.classList.add('hidden');
    clearAllStatsPolling();
    return;
  }

  emptyState.classList.add('hidden');
  appsGrid.classList.remove('hidden');

  // Keep track of apps currently in the list to manage polling intervals
  const runningAppNames = [];

  // Build grid content
  appsGrid.innerHTML = '';
  deployments.forEach(app => {
    const card = document.createElement('div');
    card.className = 'app-card';
    card.id = `app-card-${app.app_name}`;

    const dateStr = new Date(app.created_at).toLocaleString();
    
    // Check if status is running to add it to polling
    if (app.status === 'running') {
      runningAppNames.push(app.app_name);
    }

    card.innerHTML = `
      <div class="app-card-header">
        <div class="app-card-title-group">
          <span class="app-card-title" style="cursor: pointer;" onclick="openAppDetails('${app.app_name}')" onmouseover="this.style.color='var(--color-accent)'" onmouseout="this.style.color='var(--color-primary)'" title="Click to view detailed configuration">${app.app_name}</span>
          <span class="app-card-domain">
            🔗 <a href="${app.local_domain}" target="_blank">${app.app_name}.localhost</a>
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
        <div><strong>Git:</strong> ${app.git_url}</div>
        <div><strong>Deployed:</strong> ${dateStr}</div>
        ${app.cpu_limit ? `<div><strong>Limit:</strong> ${app.cpu_limit} CPU | ${app.memory_limit || 'No Mem Limit'}</div>` : ''}
      </div>

      <div class="app-actions">
        <button class="btn btn-secondary btn-sm btn-logs" onclick="showLogs('${app.app_name}')">Logs</button>
        <button class="btn btn-secondary btn-sm" onclick="restartApp('${app.app_name}')" ${app.status !== 'running' ? 'disabled' : ''}>Restart</button>
        <button class="btn btn-secondary btn-sm" onclick="stopApp('${app.app_name}')" ${app.status !== 'running' ? 'disabled' : ''}>Stop</button>
        <button class="btn btn-danger-outline btn-sm btn-delete" onclick="deleteApp('${app.app_name}')">Delete</button>
      </div>
    `;

    appsGrid.appendChild(card);
  });

  // Sync resource statistics polling
  syncStatsPolling(runningAppNames);
}

/* ==========================================================================
   Container Lifecycle Control Actions
   ========================================================================== */

async function stopApp(appName) {
  try {
    const res = await fetch(`${API_BASE}/api/apps/${appName}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error('Stop request failed');
    fetchDeployments();
  } catch (err) {
    alert(`Error stopping app: ${err.message}`);
  }
}

async function restartApp(appName) {
  try {
    const res = await fetch(`${API_BASE}/api/apps/${appName}/restart`, { method: 'POST' });
    if (!res.ok) throw new Error('Restart request failed');
    fetchDeployments();
  } catch (err) {
    alert(`Error restarting app: ${err.message}`);
  }
}

async function deleteApp(appName) {
  if (!confirm(`Are you sure you want to delete ${appName}? This will remove the container and the image.`)) {
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/api/apps/${appName}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error('Delete request failed');
    fetchDeployments();
  } catch (err) {
    alert(`Error deleting app: ${err.message}`);
  }
}

/* ==========================================================================
   Metrics/Stats Polling
   ========================================================================== */

// Sync polling timers: add new active containers, remove stopped containers
function syncStatsPolling(runningApps) {
  // Clear any timers for containers no longer running
  Object.keys(statsIntervals).forEach(appName => {
    if (!runningApps.includes(appName)) {
      clearInterval(statsIntervals[appName]);
      delete statsIntervals[appName];
    }
  });

  // Start timers for newly running containers
  runningApps.forEach(appName => {
    if (!statsIntervals[appName]) {
      // Poll immediately once, then set interval
      pollAppStats(appName);
      statsIntervals[appName] = setInterval(() => pollAppStats(appName), 3000);
    }
  });
}

// Clear all active timers
function clearAllStatsPolling() {
  Object.keys(statsIntervals).forEach(appName => {
    clearInterval(statsIntervals[appName]);
  });
  statsIntervals = {};
}

// Fetch stats for a specific app container
async function pollAppStats(appName) {
  try {
    const res = await fetch(`${API_BASE}/api/apps/${appName}/stats`);
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

      // Check if this app is currently open in the details view
      if (activeDetailsApp === appName) {
        if (detailsCpuVal) detailsCpuVal.textContent = `${data.cpu_percent}%`;
        if (detailsCpuBar) {
          detailsCpuBar.style.width = `${Math.min(data.cpu_percent, 100)}%`;
          setBarColor(detailsCpuBar, data.cpu_percent);
        }
        if (detailsMemVal) detailsMemVal.textContent = `${data.memory_usage_mb}MB / ${data.memory_limit_mb}MB`;
        if (detailsMemBar) {
          detailsMemBar.style.width = `${data.memory_percent}%`;
          setBarColor(detailsMemBar, data.memory_percent);
        }
      }
    } else {
      // Container stopped or exited
      clearInterval(statsIntervals[appName]);
      delete statsIntervals[appName];
      fetchDeployments();

      // If viewing the details view of this stopped app, update status badge and reset stats
      if (activeDetailsApp === appName) {
        detailsStatusBadge.className = `status-badge ${data.status}`;
        detailsStatusText.textContent = data.status;
        if (detailsCpuVal) detailsCpuVal.textContent = '0%';
        if (detailsCpuBar) detailsCpuBar.style.width = '0%';
        if (detailsMemVal) detailsMemVal.textContent = '0MB / 0MB';
        if (detailsMemBar) detailsMemBar.style.width = '0%';
      }
    }
  } catch (err) {
    console.error(`Error polling stats for ${appName}:`, err);
  }
}

// Dynamic progress bar styling based on utilization levels
function setBarColor(barElement, percentage) {
  barElement.classList.remove('warning', 'danger');
  if (percentage >= 85) {
    barElement.classList.add('danger');
  } else if (percentage >= 70) {
    barElement.classList.add('warning');
  }
}

/* ==========================================================================
   Deployment Submission
   ========================================================================== */

deployForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  const app_name = document.getElementById('app_name').value.trim().toLowerCase();
  const git_url = document.getElementById('git_url').value.trim();
  const port = parseInt(document.getElementById('port').value, 10);
  const cpu_limit = document.getElementById('cpu_limit').value;
  const memory_limit = document.getElementById('memory_limit').value.trim();
  const env_vars = getEnvVariables();

  const payload = {
    app_name,
    git_url,
    port,
    cpu_limit: cpu_limit ? parseFloat(cpu_limit) : null,
    memory_limit: memory_limit || null,
    env_vars
  };

  const btnDeploy = document.getElementById('btn-deploy');
  btnDeploy.disabled = true;
  btnDeploy.querySelector('span').textContent = 'Initiating...';

  try {
    const res = await fetch(`${API_BASE}/api/deploy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    
    if (!res.ok) {
      throw new Error(data.detail || 'Deployment failed to initialize');
    }

    // Launch log modal immediately to show build feedback
    showLogs(app_name);
    
    // Clear and reload list
    deployForm.reset();
    envList.innerHTML = '';
    await fetchDeployments();

  } catch (err) {
    alert(`Deployment error: ${err.message}`);
  } finally {
    btnDeploy.disabled = false;
    btnDeploy.querySelector('span').textContent = 'Launch Deployment';
  }
});

/* ==========================================================================
   WebSocket Logs Console
   ========================================================================== */

function showLogs(appName) {
  activeLogApp = appName;
  modalAppTitle.textContent = `Deployment Console: ${appName}`;
  terminalConsole.innerHTML = '';
  
  // Close existing socket if open
  if (logSocket) {
    logSocket.close();
  }

  // Open modal first
  logsModal.classList.add('active');
  logsModal.setAttribute('aria-hidden', 'false');

  // Establish WebSocket connection
  const socketUrl = `${WS_BASE}/ws/logs/${appName}`;
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
  
  // Color codes matching log contexts
  if (text.startsWith('---') || text.includes('Successfully deployed!')) {
    line.style.color = '#38bdf8'; // Sky blue accent
    line.style.fontWeight = 'bold';
  } else if (text.startsWith('Deployment ERROR:') || text.startsWith('[container] ERROR')) {
    line.style.color = '#ef4444'; // Red accent
  } else if (text.startsWith('[UI-CLIENT]')) {
    line.style.color = '#64748b'; // Slate gray
  } else if (text.startsWith('[container]')) {
    line.style.color = '#cbd5e1'; // Light gray for app runtime stdout
  } else {
    line.style.color = '#10b981'; // Mint green for standard docker builds
  }

  terminalConsole.appendChild(line);
  // Auto scroll to bottom
  terminalConsole.scrollTop = terminalConsole.scrollHeight;
}

// Close Modal Controls
function closeModal() {
  logsModal.classList.remove('active');
  logsModal.setAttribute('aria-hidden', 'true');
  if (logSocket) {
    logSocket.close();
    logSocket = null;
  }
  activeLogApp = null;
  // Reload deployments in case status changed from building
  fetchDeployments();
}

btnCloseModal.addEventListener('click', closeModal);
document.querySelector('.modal-backdrop').addEventListener('click', closeModal);

// Clear console
btnModalClear.addEventListener('click', () => {
  terminalConsole.innerHTML = '';
});

// Copy logs to clipboard
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

/* ==========================================================================
   Page Init
   ========================================================================== */

window.addEventListener('DOMContentLoaded', () => {
  fetchDeployments();
  // Poll deployments state list every 10 seconds to keep UI synced
  setInterval(fetchDeployments, 10000);
});

// ==========================================================================
// Detailed View Controller Logic
// ==========================================================================

async function openAppDetails(appName) {
  activeDetailsApp = appName;
  
  const app = deployments.find(d => d.app_name === appName);
  if (!app) return;

  // Swap workspace view
  dashboardViewWrapper.classList.add('hidden');
  detailsView.classList.remove('hidden');
  
  // Bind details view metadata
  detailsAppName.textContent = app.app_name;
  detailsAppLink.href = app.local_domain;
  detailsAppLink.textContent = `${app.app_name}.localhost`;
  
  detailsStatusBadge.className = `status-badge ${app.status}`;
  detailsStatusText.textContent = app.status;

  detailsGitUrl.textContent = app.git_url;
  detailsPort.textContent = app.port;
  detailsCpuLimit.textContent = app.cpu_limit ? `${app.cpu_limit} Cores` : 'None';
  detailsMemLimit.textContent = app.memory_limit || 'None';
  detailsCreatedAt.textContent = new Date(app.created_at).toLocaleString();

  // Env variables
  detailsEnvList.innerHTML = '';
  const envKeys = Object.keys(app.env_vars || {});
  if (envKeys.length === 0) {
    detailsEnvList.innerHTML = '<div style="font-size: 0.85rem; color: var(--color-text-muted);">No environment variables defined.</div>';
  } else {
    envKeys.forEach(key => {
      const item = document.createElement('div');
      item.className = 'env-item';
      item.innerHTML = `
        <span class="env-key">${key}</span>
        <span class="env-val">${app.env_vars[key]}</span>
      `;
      detailsEnvList.appendChild(item);
    });
  }

  // Bind Actions
  btnDetailsRestart.onclick = async () => {
    btnDetailsRestart.disabled = true;
    btnDetailsRestart.textContent = 'Restarting...';
    try {
      await restartApp(appName);
      setTimeout(async () => {
        await fetchDeployments();
        openAppDetails(appName);
      }, 1000);
    } catch (e) {
      alert(e.message);
    } finally {
      btnDetailsRestart.disabled = false;
      btnDetailsRestart.textContent = 'Restart App';
    }
  };

  btnDetailsStop.onclick = async () => {
    btnDetailsStop.disabled = true;
    btnDetailsStop.textContent = 'Stopping...';
    try {
      await stopApp(appName);
      setTimeout(async () => {
        await fetchDeployments();
        openAppDetails(appName);
      }, 1000);
    } catch (e) {
      alert(e.message);
    } finally {
      btnDetailsStop.disabled = false;
      btnDetailsStop.textContent = 'Stop App';
    }
  };

  btnDetailsDelete.onclick = async () => {
    if (confirm(`Are you sure you want to delete ${appName}? This will remove the container and the image.`)) {
      btnDetailsDelete.disabled = true;
      btnDetailsDelete.textContent = 'Deleting...';
      try {
        await deleteApp(appName);
        closeAppDetails();
      } catch (e) {
        alert(e.message);
      } finally {
        btnDetailsDelete.disabled = false;
        btnDetailsDelete.textContent = 'Delete App';
      }
    }
  };

  // Bind Terminal Stream
  detailsTerminal.innerHTML = '';
  if (detailsSocket) {
    detailsSocket.close();
  }

  const socketUrl = `${WS_BASE}/ws/logs/${appName}`;
  detailsSocket = new WebSocket(socketUrl);

  detailsSocket.onmessage = (event) => {
    const line = document.createElement('div');
    line.textContent = event.data;
    if (event.data.startsWith('---') || event.data.includes('Successfully deployed!')) {
      line.style.color = '#38bdf8';
      line.style.fontWeight = 'bold';
    } else if (event.data.startsWith('Deployment ERROR:') || event.data.startsWith('[container] ERROR')) {
      line.style.color = '#ef4444';
    } else if (event.data.startsWith('[container]')) {
      line.style.color = '#cbd5e1';
    } else {
      line.style.color = '#10b981';
    }
    detailsTerminal.appendChild(line);
    detailsTerminal.scrollTop = detailsTerminal.scrollHeight;
  };

  detailsSocket.onclose = () => {
    const line = document.createElement('div');
    line.textContent = '[UI-CLIENT] WebSocket stream closed.';
    line.style.color = '#64748b';
    detailsTerminal.appendChild(line);
    detailsTerminal.scrollTop = detailsTerminal.scrollHeight;
  };

  btnDetailsCopyLogs.onclick = () => {
    const logLines = Array.from(detailsTerminal.children).map(child => child.textContent);
    const fullLog = logLines.join('\n');
    navigator.clipboard.writeText(fullLog).then(() => {
      const originalText = btnDetailsCopyLogs.textContent;
      btnDetailsCopyLogs.textContent = 'Copied!';
      btnDetailsCopyLogs.style.borderColor = 'var(--color-success)';
      btnDetailsCopyLogs.style.color = 'var(--color-success)';
      setTimeout(() => {
        btnDetailsCopyLogs.textContent = originalText;
        btnDetailsCopyLogs.style.borderColor = '';
        btnDetailsCopyLogs.style.color = '';
      }, 2000);
    });
  };

  // Perform initial stats call
  pollAppStats(appName);
}

function closeAppDetails() {
  activeDetailsApp = null;
  dashboardViewWrapper.classList.remove('hidden');
  detailsView.classList.add('hidden');
  
  if (detailsSocket) {
    detailsSocket.close();
    detailsSocket = null;
  }
  
  fetchDeployments();
}

btnBackDashboard.addEventListener('click', closeAppDetails);
