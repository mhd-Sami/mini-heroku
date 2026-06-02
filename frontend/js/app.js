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
    
    localStorage.setItem('mini_heroku_deployments_cache', JSON.stringify(deployments));
    updateMetricsUI(deployments);
    generateActivityTimeline(deployments);
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

    // Redirect to active deployments grid on success
    window.location.href = `apps.html?deploying=${app_name}`;

  } catch (err) {
    alert(`Deployment error: ${err.message}`);
  } finally {
    btnDeploy.disabled = false;
    btnDeploy.querySelector('span').textContent = 'Launch Deployment';
  }
});

// Load metrics on start
function loadCachedMetrics() {
  const cached = localStorage.getItem('mini_heroku_deployments_cache');
  if (cached) {
    try {
      const deployments = JSON.parse(cached);
      if (deployments) {
        updateMetricsUI(deployments);
      }
    } catch (e) {
      console.error("Failed to parse cached metrics:", e);
    }
  }
}
loadCachedMetrics();
fetchMetrics();

// Quick Fill Suggestions for resource allocation parameters
document.querySelectorAll('#cpu-suggestions .quick-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    document.getElementById('cpu_limit').value = tag.getAttribute('data-value');
  });
});
document.querySelectorAll('#mem-suggestions .quick-tag').forEach(tag => {
  tag.addEventListener('click', () => {
    document.getElementById('memory_limit').value = tag.getAttribute('data-value');
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

function generateActivityTimeline(deployments) {
  const timeline = document.getElementById('activity-timeline');
  if (!timeline) return;

  const events = [];

  // Add system events
  events.push({
    title: "Vessel Daemon online",
    desc: "Connection to Docker socket initialized",
    time: new Date(Date.now() - 60000 * 55).toLocaleTimeString(),
    type: "system"
  });
  events.push({
    title: "Git Poller active",
    desc: "Auto-deployment remote commit checks active (60s loop)",
    time: new Date(Date.now() - 60000 * 30).toLocaleTimeString(),
    type: "poller"
  });

  // Add application specific events
  deployments.forEach(app => {
    let title = "";
    let desc = "";
    let type = "info";
    const dateStr = new Date(app.updated_at || app.created_at).toLocaleTimeString();

    if (app.status === 'running') {
      title = `${app.app_name} is running`;
      desc = `Routing active: http://${app.app_name}.localhost`;
      type = "success";
    } else if (app.status === 'stopped') {
      title = `${app.app_name} container stopped`;
      desc = `Deployment preserved`;
      type = "stopped";
    } else if (app.status === 'failed') {
      title = `${app.app_name} build failed`;
      desc = `Check build logs for errors`;
      type = "danger";
    } else if (app.status === 'building') {
      title = `${app.app_name} building`;
      desc = `Compiling layers via BuildKit`;
      type = "building";
    }

    events.push({
      title,
      desc,
      time: dateStr,
      type
    });
  });

  timeline.innerHTML = '';
  events.forEach(ev => {
    let dotColor = "var(--color-text-muted)";
    if (ev.type === 'success') dotColor = "var(--color-success)";
    if (ev.type === 'building') dotColor = "var(--color-info)";
    if (ev.type === 'danger') dotColor = "var(--color-danger)";
    if (ev.type === 'system' || ev.type === 'poller') dotColor = "var(--color-accent)";

    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 0.75rem; align-items: flex-start; margin-bottom: 0.8rem; position: relative;';
    row.innerHTML = `
      <span class="pulse-dot" style="background-color: ${dotColor}; margin-top: 0.25rem; width: 6px; height: 6px; flex-shrink: 0; transform: scale(1.15);"></span>
      <div style="display: flex; flex-direction: column; gap: 0.1rem; flex: 1;">
        <span style="font-weight: 600; color: var(--color-text-main); line-height: 1.2;">${ev.title}</span>
        <span style="color: var(--color-text-muted); font-size: 0.72rem; line-height: 1.2;">${ev.desc}</span>
      </div>
      <span style="color: var(--color-text-muted); font-size: 0.7rem; flex-shrink: 0; font-family: var(--font-family-mono);">${ev.time}</span>
    `;
    timeline.appendChild(row);
  });
}

fetchSystemInfo();
