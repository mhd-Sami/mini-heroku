const API_BASE = window.location.origin;

// DOM Elements
const deployForm = document.getElementById('deploy-form');
const btnAddEnv = document.getElementById('btn-add-env');
const envList = document.getElementById('env-list');

const metricTotalApps = document.getElementById('metric-total-apps');
const metricRunningApps = document.getElementById('metric-running-apps');

/* ==========================================================================
   Environment Variables Form Builder
   ========================================================================== */

function addEnvRow(key = '', val = '') {
  const row = document.createElement('div');
  row.className = 'env-row';
  row.innerHTML = `
    <input type="text" class="env-key" placeholder="KEY" value="${key}" required pattern="^[a-zA-Z_][a-zA-Z0-9_]*$" title="Valid env variable name (letters, numbers, underscores, starting with letter)">
    <input type="text" class="env-value" placeholder="value" value="${val}">
    <button type="button" class="btn-remove-env" title="Remove">&times;</button>
  `;
  
  row.querySelector('.btn-remove-env').addEventListener('click', () => {
    row.remove();
  });
  
  envList.appendChild(row);
}

btnAddEnv.addEventListener('click', () => addEnvRow());

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
   Fetch Dashboard Metrics
   ========================================================================== */

async function fetchMetrics() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps`);
    if (!res.ok) throw new Error('Failed to load apps');
    const deployments = await res.json();
    
    // Fetch deployment history for real-time activity timeline
    let history = [];
    try {
      const histRes = await authFetch(`${API_BASE}/api/deployments/history`);
      if (histRes.ok) {
        history = await histRes.json();
      }
    } catch (e) {
      console.error("Failed to load history in dashboard metrics:", e);
    }
    
    localStorage.setItem('mini_heroku_deployments_cache', JSON.stringify(deployments));
    if (history.length > 0) {
      localStorage.setItem('mini_heroku_history_cache', JSON.stringify(history));
    }
    
    updateMetricsUI(deployments);
    renderActiveServicesSummary(deployments);
    generateActivityTimeline(deployments, history);
  } catch (err) {
    console.error('Error fetching metrics:', err);
  }
}

function updateMetricsUI(deployments) {
  if (metricTotalApps) metricTotalApps.textContent = deployments.length;
  const runningCount = deployments.filter(d => d.status === 'running').length;
  if (metricRunningApps) metricRunningApps.textContent = runningCount;
}

/* ==========================================================================
   Deployment Submission
   ========================================================================== */

/* ==========================================================================
   Active Services Summary Table
   ========================================================================== */

function renderActiveServicesSummary(deployments) {
  const summaryTableBody = document.getElementById('summary-table-body');
  if (!summaryTableBody) return;

  const runningApps = deployments.filter(d => d.status === 'running');

  if (runningApps.length === 0) {
    summaryTableBody.innerHTML = `
      <tr>
        <td colspan="4" style="color: var(--color-text-muted); text-align: center; padding: 2rem; font-size: 0.85rem;">
          No active services running. <a href="#" id="summary-deploy-link" style="color: var(--color-accent); font-weight: 600; text-decoration: underline;">Deploy one now</a>
        </td>
      </tr>
    `;
    const link = document.getElementById('summary-deploy-link');
    if (link) {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        openDeployModal();
      });
    }
    return;
  }

  const topApps = runningApps.slice(0, 4);
  summaryTableBody.innerHTML = '';

  topApps.forEach(app => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td style="font-weight: 600; color: var(--color-text-main); font-size: 0.85rem; padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-bg-alt);">${app.app_name}</td>
      <td style="font-size: 0.82rem; padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-bg-alt);">
        <a href="${app.local_domain}" target="_blank" style="color: var(--color-primary-light); font-weight: 500;">${app.app_name}.localhost</a>
      </td>
      <td style="padding: 0.75rem 1rem; border-bottom: 1px solid var(--color-bg-alt);">
        <span class="status-badge running" style="padding: 0.15rem 0.5rem; font-size: 0.7rem;">
          <span class="pulse-dot"></span>
          <span class="status-text">running</span>
        </span>
      </td>
      <td style="text-align: right; padding: 0.75rem 1rem; padding-right: 1.5rem; border-bottom: 1px solid var(--color-bg-alt);">
        <a href="app-details.html?app=${app.app_name}" class="btn btn-secondary btn-sm" style="padding: 0.25rem 0.6rem; font-size: 0.75rem; font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem;">
          Manage
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </a>
      </td>
    `;
    summaryTableBody.appendChild(tr);
  });
}

/* ==========================================================================
   Deploy Modal Logic
   ========================================================================== */

const deployModal = document.getElementById('deploy-modal');
const btnHeroDeployTrigger = document.getElementById('btn-hero-deploy-trigger');
const btnCloseDeployModal = document.getElementById('btn-close-deploy-modal');
const modalBackdrop = deployModal ? deployModal.querySelector('.modal-backdrop') : null;

function openDeployModal() {
  if (deployModal) {
    deployModal.classList.add('active');
    deployModal.setAttribute('aria-hidden', 'false');
  }
}

function closeDeployModal() {
  if (deployModal) {
    deployModal.classList.remove('active');
    deployModal.setAttribute('aria-hidden', 'true');
    if (deployForm) deployForm.reset();
    if (envList) envList.innerHTML = '';
  }
}

if (btnHeroDeployTrigger) {
  btnHeroDeployTrigger.addEventListener('click', openDeployModal);
}
if (btnCloseDeployModal) {
  btnCloseDeployModal.addEventListener('click', closeDeployModal);
}
if (modalBackdrop) {
  modalBackdrop.addEventListener('click', closeDeployModal);
}

// Global hook for navbar shortcut trigger if on index page
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.btn-nav-deploy');
  if (btn) {
    e.preventDefault();
    openDeployModal();
  }
});

function checkActionParam() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('action') === 'deploy') {
    openDeployModal();
    const newUrl = window.location.pathname;
    window.history.replaceState({}, document.title, newUrl);
  }
}

/* ==========================================================================
   Deployment Submission
   ========================================================================== */

if (deployForm) {
  deployForm.addEventListener('submit', async (e) => {
    e.preventDefault();

    const app_name = document.getElementById('app_name').value.trim().toLowerCase();
    const git_url = document.getElementById('git_url').value.trim();
    const port = parseInt(document.getElementById('port').value, 10);
    const cpu_limit = document.getElementById('cpu_limit').value;
    const memory_limit = document.getElementById('memory_limit').value.trim();
    const env_vars = getEnvVariables();
    const auto_deploy = document.getElementById('auto_deploy').checked;

    const payload = {
      app_name,
      git_url,
      port,
      cpu_limit: cpu_limit ? parseFloat(cpu_limit) : null,
      memory_limit: memory_limit || null,
      env_vars,
      auto_deploy
    };

    const btnDeploy = document.getElementById('btn-deploy');
    btnDeploy.disabled = true;
    btnDeploy.querySelector('span').innerHTML = '<span class="btn-spinner"></span> Initiating...';

    try {
      const res = await authFetch(`${API_BASE}/api/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.detail || 'Deployment failed to initialize');
      }

      closeDeployModal();
      window.location.href = `apps.html?deploying=${app_name}`;

    } catch (err) {
      alert(`Deployment error: ${err.message}`);
    } finally {
      btnDeploy.disabled = false;
      btnDeploy.querySelector('span').textContent = 'Launch Deployment';
    }
  });
}

// Load metrics on start
function loadCachedMetrics() {
  const cached = localStorage.getItem('mini_heroku_deployments_cache');
  if (cached) {
    try {
      const deployments = JSON.parse(cached);
      if (deployments) {
        updateMetricsUI(deployments);
        renderActiveServicesSummary(deployments);
      }
    } catch (e) {
      console.error("Failed to parse cached metrics:", e);
    }
  }
}
loadCachedMetrics();
fetchMetrics();
checkActionParam();

// Quick Fill Suggestions for resource allocation parameters
document.querySelectorAll('#cpu-suggestions .quick-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    const input = document.getElementById('cpu_limit');
    if (input) input.value = tag.getAttribute('data-value');
  });
});
document.querySelectorAll('#mem-suggestions .quick-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    const input = document.getElementById('memory_limit');
    if (input) input.value = tag.getAttribute('data-value');
  });
});

async function fetchSystemInfo() {
  try {
    const res = await authFetch(`${API_BASE}/api/system-info`);
    if (!res.ok) throw new Error("Failed to fetch system info");
    const data = await res.json();

    document.getElementById('host-platform').textContent = data.platform || '--';
    document.getElementById('host-cpu').textContent = `${data.cpu_cores || 1} Cores`;
    document.getElementById('host-docker').textContent = data.docker_version || '--';

    const diskFree = data.disk_free_gb || 0;
    const diskPercent = data.disk_percent || 0;
    document.getElementById('host-disk-text').textContent = `${diskFree} GB free`;
    document.getElementById('host-disk-bar').style.width = `${diskPercent}%`;
  } catch (err) {
    console.error("Error loading host node info:", err);
  }
}

function generateActivityTimeline(deployments, history = []) {
  const timeline = document.getElementById('activity-timeline');
  if (!timeline) return;

  const events = [];

  // Add system events (static benchmark for session)
  events.push({
    title: "Vessel Daemon online",
    desc: "Connection to Docker socket active",
    timestamp: new Date(Date.now() - 3600 * 1000 * 2), // 2 hours ago
    type: "system"
  });

  // Add real history outcomes
  history.forEach(item => {
    if (item.status === 'success') {
      events.push({
        title: `${item.app_name} deployed successfully`,
        desc: `Source: ${item.git_url}`,
        timestamp: new Date(item.deployed_at),
        type: "success"
      });
    } else {
      events.push({
        title: `${item.app_name} build failed`,
        desc: `Compilation error. Source: ${item.git_url}`,
        timestamp: new Date(item.deployed_at),
        type: "danger"
      });
    }
  });

  // Add active compilation or stopped status from current deployments
  deployments.forEach(app => {
    const appTime = new Date(app.updated_at || app.created_at);
    
    if (app.status === 'building') {
      events.push({
        title: `${app.app_name} is compiling`,
        desc: `Docker image layers building...`,
        timestamp: appTime,
        type: "building"
      });
    } else if (app.status === 'stopped') {
      events.push({
        title: `${app.app_name} container stopped`,
        desc: `Container paused manually or halted`,
        timestamp: appTime,
        type: "stopped"
      });
    }
  });

  // Sort events by timestamp descending (newest first)
  events.sort((a, b) => b.timestamp - a.timestamp);

  if (events.length === 1) { // Only "Vessel Daemon online"
    timeline.innerHTML = `
      <div style="color: var(--color-text-muted); text-align: center; padding: 2rem 0; font-size: 0.8rem;">
        No recent build activity.
      </div>
    `;
    return;
  }

  timeline.innerHTML = '';
  events.forEach(ev => {
    let dotColor = "var(--color-text-muted)";
    if (ev.type === 'success') dotColor = "var(--color-success)";
    if (ev.type === 'building') dotColor = "var(--color-info)";
    if (ev.type === 'danger') dotColor = "var(--color-danger)";
    if (ev.type === 'system') dotColor = "var(--color-accent)";

    const timeStr = formatTimelineTime(ev.timestamp);

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 0.75rem; align-items: flex-start; margin-bottom: 0.8rem; position: relative;';
    row.innerHTML = `
      <span class="pulse-dot" style="background-color: ${dotColor}; margin-top: 0.25rem; width: 6px; height: 6px; flex-shrink: 0; transform: scale(1.15);"></span>
      <div style="display: flex; flex-direction: column; gap: 0.1rem; flex: 1;">
        <span style="font-weight: 600; color: var(--color-text-main); line-height: 1.2;">${ev.title}</span>
        <span style="color: var(--color-text-muted); font-size: 0.72rem; line-height: 1.2; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${ev.desc}">${ev.desc}</span>
      </div>
      <span style="color: var(--color-text-muted); font-size: 0.7rem; flex-shrink: 0; font-family: var(--font-family-mono);" title="${ev.timestamp.toLocaleString()}">${timeStr}</span>
    `;
    timeline.appendChild(row);
  });
}

function formatTimelineTime(date) {
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24 && date.getDate() === now.getDate()) {
    return `${diffHours}h ago`;
  }
  
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return `${diffDays}d ago`;
  
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Initial System Queries
fetchSystemInfo();

// Set dashboard updates to loop in real-time every 5 seconds
setInterval(fetchMetrics, 5000);
