const API_BASE = window.location.origin;

let deployments = [];
let statsIntervals = {};

const emptyState = document.getElementById('empty-state');
const appsGrid = document.getElementById('apps-grid');

async function fetchDeployments() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps`);
    if (!res.ok) throw new Error('Failed to load deployments');
    deployments = await res.json();
    renderDashboard();
  } catch (err) {
    console.error('Error fetching deployments:', err);
  }
}

function renderDashboard() {
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
    card.querySelector('.btn-start').addEventListener('click', () => startApp(app.app_name));
    card.querySelector('.btn-stop').addEventListener('click', () => stopApp(app.app_name));
    card.querySelector('.btn-delete').addEventListener('click', () => deleteApp(app.app_name));

    appsGrid.appendChild(card);
  });

  syncStatsPolling(runningAppNames);
}

// Actions
async function startApp(appName) {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/start`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to start application');
    fetchDeployments();
  } catch (err) {
    alert(`Error starting app: ${err.message}`);
  }
}

async function stopApp(appName) {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/stop`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to stop application');
    fetchDeployments();
  } catch (err) {
    alert(`Error stopping app: ${err.message}`);
  }
}

async function deleteApp(appName) {
  if (!confirm(`Are you sure you want to delete ${appName}? This will permanently remove the container and image.`)) {
    return;
  }
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/delete`, { method: 'POST' });
    if (!res.ok) throw new Error('Failed to delete application');
    fetchDeployments();
  } catch (err) {
    alert(`Error deleting app: ${err.message}`);
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

// Initial load
fetchDeployments();
