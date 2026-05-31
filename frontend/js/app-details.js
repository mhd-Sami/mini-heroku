const API_BASE = window.location.origin;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${wsProtocol}//${window.location.host}`;

// State
let appName = '';
let detailsSocket = null;
let statsInterval = null;

// DOM Elements
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
const btnDetailsStart = document.getElementById('btn-details-start');
const btnDetailsStop = document.getElementById('btn-details-stop');
const btnDetailsRestart = document.getElementById('btn-details-restart');
const btnDetailsDelete = document.getElementById('btn-details-delete');

// Parse Query Parameters
function parseQuery() {
  const params = new URLSearchParams(window.location.search);
  appName = params.get('app');
  if (!appName) {
    window.location.href = 'apps.html';
    return;
  }
  loadDetails();
}

async function loadDetails() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps`);
    if (!res.ok) throw new Error('Failed to load apps');
    const apps = await res.json();
    const app = apps.find(d => d.app_name === appName);
    
    if (!app) {
      alert("Application not found or access denied.");
      window.location.href = 'apps.html';
      return;
    }

    renderDetails(app);
  } catch (err) {
    console.error('Error loading details:', err);
    alert('Failed to load specifications.');
    window.location.href = 'apps.html';
  }
}

function renderDetails(app) {
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

  // Render environment variables
  detailsEnvList.innerHTML = '';
  const envKeys = Object.keys(app.env_vars || {});
  if (envKeys.length === 0) {
    detailsEnvList.innerHTML = '<div style="font-size: 0.85rem; color: var(--color-text-muted);">No environment variables configured.</div>';
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

  // Buttons status
  btnDetailsStart.disabled = app.status === 'running';
  btnDetailsStop.disabled = app.status !== 'running';
  btnDetailsRestart.disabled = app.status !== 'running';

  // Bind Actions
  btnDetailsStart.onclick = () => runAction('start');
  btnDetailsStop.onclick = () => runAction('stop');
  btnDetailsRestart.onclick = () => runAction('restart');
  btnDetailsDelete.onclick = deleteApp;

  // Stream Logs
  connectLogs();

  // Poll Stats
  startStatsPolling();
}

async function runAction(action) {
  const btn = action === 'start' ? btnDetailsStart : (action === 'stop' ? btnDetailsStop : btnDetailsRestart);
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"></span> ${action.charAt(0).toUpperCase() + action.slice(1)}ing...`;

  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`Operation ${action} failed`);
    
    // Reload state after short delay
    setTimeout(loadDetails, 1500);
  } catch (err) {
    alert(`Error running command: ${err.message}`);
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

async function deleteApp() {
  if (!confirm(`Are you sure you want to delete ${appName}? This will permanently delete the container and image.`)) {
    return;
  }
  btnDetailsDelete.disabled = true;
  btnDetailsDelete.innerHTML = '<span class="btn-spinner"></span> Deleting...';
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error('Deletion failed');
    window.location.href = 'apps.html';
  } catch (err) {
    alert(`Error: ${err.message}`);
    btnDetailsDelete.disabled = false;
    btnDetailsDelete.textContent = 'Delete App';
  }
}

function connectLogs() {
  if (detailsSocket) {
    detailsSocket.close();
  }
  detailsTerminal.innerHTML = '';
  
  const token = localStorage.getItem('mini_heroku_token');
  const socketUrl = `${WS_BASE}/ws/logs/${appName}?token=${encodeURIComponent(token || '')}`;
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

  detailsSocket.onclose = (event) => {
    const line = document.createElement('div');
    if (event.code === 1008) {
      line.textContent = '[UI-CLIENT] Connection closed: Session expired or access denied.';
      line.style.color = '#ef4444';
    } else {
      line.textContent = '[UI-CLIENT] Live logs disconnected.';
      line.style.color = '#64748b';
    }
    detailsTerminal.appendChild(line);
    detailsTerminal.scrollTop = detailsTerminal.scrollHeight;
  };
}

function startStatsPolling() {
  if (statsInterval) {
    clearInterval(statsInterval);
  }
  pollStats();
  statsInterval = setInterval(pollStats, 3000);
}

async function pollStats() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/stats`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.status === 'running') {
      detailsCpuVal.textContent = `${data.cpu_percent}%`;
      detailsCpuBar.style.width = `${Math.min(data.cpu_percent, 100)}%`;
      setBarColor(detailsCpuBar, data.cpu_percent);

      detailsMemVal.textContent = `${data.memory_usage_mb}MB / ${data.memory_limit_mb}MB`;
      detailsMemBar.style.width = `${data.memory_percent}%`;
      setBarColor(detailsMemBar, data.memory_percent);
      
      detailsStatusBadge.className = 'status-badge running';
      detailsStatusText.textContent = 'RUNNING';
      btnDetailsStart.disabled = true;
      btnDetailsStop.disabled = false;
      btnDetailsRestart.disabled = false;
    } else {
      detailsCpuVal.textContent = '0%';
      detailsCpuBar.style.width = '0%';
      detailsMemVal.textContent = '0MB / 0MB';
      detailsMemBar.style.width = '0%';
      
      detailsStatusBadge.className = `status-badge ${data.status}`;
      detailsStatusText.textContent = data.status.toUpperCase();
      btnDetailsStart.disabled = data.status === 'building';
      btnDetailsStop.disabled = true;
      btnDetailsRestart.disabled = true;
    }
  } catch (err) {
    console.error('Stats error:', err);
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

// Copy Logs
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

// Parse parameters on load
parseQuery();
