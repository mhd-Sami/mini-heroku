const API_BASE = window.location.origin;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${wsProtocol}//${window.location.host}`;

// State
let appName = '';
let detailsSocket = null;
let statsInterval = null;
let lastStatus = ''; // Track last status to detect auto-deployment transitions
let activeAppObj = null; // Store active app details object

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
const detailsUpdatedAt = document.getElementById('details-updated-at');
const detailsEnvList = document.getElementById('details-env-list');
const detailsTerminal = document.getElementById('details-terminal');
const detailsAutoDeploy = document.getElementById('details-auto-deploy');

const btnDetailsCopyLogs = document.getElementById('btn-details-copy-logs');
const btnDetailsStart = document.getElementById('btn-details-start');
const btnDetailsStop = document.getElementById('btn-details-stop');
const btnDetailsRestart = document.getElementById('btn-details-restart');
const btnDetailsDelete = document.getElementById('btn-details-delete');

// Configuration Edit Form Elements
const btnEditConfig = document.getElementById('btn-edit-config');
const btnCancelConfig = document.getElementById('btn-cancel-config');
const configViewMode = document.getElementById('config-view-mode');
const configEditForm = document.getElementById('config-edit-form');
const editGitUrl = document.getElementById('edit-git-url');
const editPort = document.getElementById('edit-port');
const editAutoDeploy = document.getElementById('edit-auto-deploy');
const editCpuLimit = document.getElementById('edit-cpu-limit');
const editMemLimit = document.getElementById('edit-mem-limit');

// Env Var Form Elements
const btnShowAddEnv = document.getElementById('btn-show-add-env');
const btnCancelAddEnv = document.getElementById('btn-cancel-add-env');
const envAddForm = document.getElementById('env-add-form');
const envNewKey = document.getElementById('env-new-key');
const envNewValue = document.getElementById('env-new-value');

// Insights DOM Elements
const insightIp = document.getElementById('insight-ip');
const insightSize = document.getElementById('insight-size');
const insightUptime = document.getElementById('insight-uptime');
const insightRestarts = document.getElementById('insight-restarts');

// Parse Query Parameters
function parseQuery() {
  const params = new URLSearchParams(window.location.search);
  appName = params.get('app');
  if (!appName) {
    window.location.href = 'apps.html';
    return;
  }
  
  // Instant Cache Render
  loadCachedDetails();
  
  // Background SWR Fetch
  loadDetails();
}

function loadCachedDetails() {
  try {
    const cached = AppCache.get('mini_heroku_deployments_cache');
    if (cached && Array.isArray(cached)) {
      const app = cached.find(d => d.app_name === appName);
      if (app) {
        renderDetails(app);
      }
    }
  } catch (e) {
    console.error("Error loading cached details:", e);
  }
}

async function loadDetails() {
  // SWR style fetch
  swrFetch(`${API_BASE}/api/apps`, 'mini_heroku_deployments_cache', (apps) => {
    const app = apps.find(d => d.app_name === appName);
    if (!app) {
      alert("Application not found or access denied.");
      window.location.href = 'apps.html';
      return;
    }
    renderDetails(app);
  });
}

function renderDetails(app) {
  activeAppObj = app;
  lastStatus = app.status;
  detailsAppName.textContent = app.app_name;
  detailsAppLink.href = app.local_domain;
  detailsAppLink.textContent = `${app.app_name}.localhost`;
  
  detailsStatusBadge.className = `status-badge ${app.status}`;
  detailsStatusText.textContent = app.status.toUpperCase();

  detailsGitUrl.textContent = app.git_url;
  detailsPort.textContent = app.port;
  detailsCpuLimit.textContent = app.cpu_limit ? `${app.cpu_limit} Cores` : 'None';
  detailsMemLimit.textContent = app.memory_limit || 'None';
  detailsCreatedAt.textContent = new Date(app.created_at).toLocaleString();
  if (detailsUpdatedAt) {
    detailsUpdatedAt.textContent = new Date(app.updated_at || app.created_at).toLocaleString();
  }

  if (detailsAutoDeploy) {
    detailsAutoDeploy.checked = app.auto_deploy || false;
  }

  // Pre-fill Edit Config values
  if (editGitUrl) editGitUrl.value = app.git_url;
  if (editPort) editPort.value = app.port;
  if (editAutoDeploy) editAutoDeploy.checked = app.auto_deploy || false;
  if (editCpuLimit) editCpuLimit.value = app.cpu_limit || '';
  if (editMemLimit) editMemLimit.value = app.memory_limit || '';

  // Render environment variables
  renderEnvironmentVariables(app.env_vars || {});

  // Lifecycle buttons status
  btnDetailsStart.disabled = app.status === 'running' || app.status === 'building';
  btnDetailsStop.disabled = app.status !== 'running';
  btnDetailsRestart.disabled = app.status !== 'running';

  // Stream Logs
  connectLogs();

  // Poll Stats
  startStatsPolling();
}

/* ==========================================================================
   Environment Variables CRUD
   ========================================================================== */

function renderEnvironmentVariables(envVars) {
  detailsEnvList.innerHTML = '';
  const envKeys = Object.keys(envVars);
  
  if (envKeys.length === 0) {
    detailsEnvList.innerHTML = '<div style="font-size: 0.85rem; color: var(--color-text-muted); text-align: center; padding: 1rem 0;">No environment variables configured.</div>';
    return;
  }

  envKeys.forEach(key => {
    const item = document.createElement('div');
    item.className = 'env-item';
    item.id = `env-row-${key}`;
    item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background-color: var(--color-bg-cream); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8rem; font-family: var(--font-family-mono); border: 1px solid var(--color-bg-alt); margin-bottom: 0.25rem;';
    
    const rawValue = envVars[key];
    const maskedValue = '••••••••';
    
    item.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 0.1rem; flex: 1;">
        <span class="env-key" style="color: var(--color-primary-light); font-weight: 700;">${key}</span>
        <div style="display: flex; align-items: center; gap: 0.5rem; margin-top: 0.15rem;">
          <span class="env-val" id="env-val-${key}" style="color: var(--color-text-main); font-weight: 600;">${maskedValue}</span>
          <input type="text" class="env-edit-input hidden" value="${rawValue}" style="height: 1.5rem; padding: 0 0.4rem; border-radius: var(--radius-sm); border: 1px solid var(--color-bg-alt); font-size: 0.78rem; font-family: var(--font-family-mono); width: 80%;">
        </div>
      </div>
      <div style="display: flex; align-items: center; gap: 0.4rem; flex-shrink: 0;">
        <button type="button" class="btn-toggle-env" style="background: none; border: none; cursor: pointer; color: var(--color-text-muted); padding: 0.2rem;" title="Show/Hide Value">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </button>
        <button type="button" class="btn-edit-env btn btn-secondary btn-xs" style="padding: 0.15rem 0.4rem; font-size: 0.7rem; font-weight: 600;">Edit</button>
        <button type="button" class="btn-save-env-inline btn btn-primary btn-xs hidden" style="padding: 0.15rem 0.4rem; font-size: 0.7rem; font-weight: 600;">Save</button>
        <button type="button" class="btn-cancel-env-inline btn btn-secondary btn-xs hidden" style="padding: 0.15rem 0.4rem; font-size: 0.7rem; font-weight: 600;">Cancel</button>
        <button type="button" class="btn-delete-env" style="background: none; border: none; cursor: pointer; color: var(--color-danger); padding: 0.2rem;" title="Delete Variable">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    `;

    const toggleBtn = item.querySelector('.btn-toggle-env');
    const editBtn = item.querySelector('.btn-edit-env');
    const deleteBtn = item.querySelector('.btn-delete-env');
    const saveInlineBtn = item.querySelector('.btn-save-env-inline');
    const cancelInlineBtn = item.querySelector('.btn-cancel-env-inline');
    
    const valSpan = item.querySelector('.env-val');
    const valInput = item.querySelector('.env-edit-input');

    // Toggle Eye icon visibility
    toggleBtn.onclick = () => {
      const isMasked = valSpan.textContent === maskedValue;
      valSpan.textContent = isMasked ? rawValue : maskedValue;
      toggleBtn.innerHTML = isMasked 
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="eye-icon"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    };

    // Toggle Inline Edit Mode
    editBtn.onclick = () => {
      valSpan.classList.add('hidden');
      valInput.classList.remove('hidden');
      toggleBtn.classList.add('hidden');
      editBtn.classList.add('hidden');
      deleteBtn.classList.add('hidden');
      saveInlineBtn.classList.remove('hidden');
      cancelInlineBtn.classList.remove('hidden');
      valInput.focus();
    };

    // Cancel Inline Edit
    cancelInlineBtn.onclick = () => {
      valSpan.classList.remove('hidden');
      valInput.classList.add('hidden');
      toggleBtn.classList.remove('hidden');
      editBtn.classList.remove('hidden');
      deleteBtn.classList.remove('hidden');
      saveInlineBtn.classList.add('hidden');
      cancelInlineBtn.classList.add('hidden');
      valInput.value = rawValue;
    };

    // Save Inline Value
    saveInlineBtn.onclick = async () => {
      const newValue = valInput.value;
      if (newValue === rawValue) {
        cancelInlineBtn.click();
        return;
      }
      
      const updatedEnv = { ...(activeAppObj.env_vars || {}) };
      updatedEnv[key] = newValue;
      
      saveInlineBtn.disabled = true;
      saveInlineBtn.textContent = '...';
      
      try {
        const success = await updateAppConfiguration({ env_vars: updatedEnv });
        if (success) {
          activeAppObj.env_vars = updatedEnv;
          renderEnvironmentVariables(updatedEnv);
        }
      } catch (err) {
        alert("Failed to update variable: " + err.message);
        saveInlineBtn.disabled = false;
        saveInlineBtn.textContent = 'Save';
      }
    };

    // Delete Variable
    deleteBtn.onclick = async () => {
      if (!confirm(`Are you sure you want to delete environment variable '${key}'?`)) {
        return;
      }
      
      const updatedEnv = { ...(activeAppObj.env_vars || {}) };
      delete updatedEnv[key];
      
      deleteBtn.disabled = true;
      
      try {
        const success = await updateAppConfiguration({ env_vars: updatedEnv });
        if (success) {
          activeAppObj.env_vars = updatedEnv;
          renderEnvironmentVariables(updatedEnv);
        }
      } catch (err) {
        alert("Failed to delete variable: " + err.message);
        deleteBtn.disabled = false;
      }
    };

    detailsEnvList.appendChild(item);
  });
}

// Show/Hide Add Env Form
if (btnShowAddEnv) {
  btnShowAddEnv.addEventListener('click', () => {
    envAddForm.style.display = 'flex';
    envNewKey.focus();
  });
}
if (btnCancelAddEnv) {
  btnCancelAddEnv.addEventListener('click', () => {
    envAddForm.reset();
    envAddForm.style.display = 'none';
  });
}

// Submit Add Env Form
if (envAddForm) {
  envAddForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = envNewKey.value.trim().toUpperCase();
    const val = envNewValue.value;
    
    if (!key) return;
    
    const updatedEnv = { ...(activeAppObj.env_vars || {}) };
    updatedEnv[key] = val;
    
    const submitBtn = envAddForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    submitBtn.textContent = '...';
    
    try {
      const success = await updateAppConfiguration({ env_vars: updatedEnv });
      if (success) {
        activeAppObj.env_vars = updatedEnv;
        renderEnvironmentVariables(updatedEnv);
        envAddForm.reset();
        envAddForm.style.display = 'none';
      }
    } catch (err) {
      alert("Failed to add variable: " + err.message);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save';
    }
  });
}

/* ==========================================================================
   Configurations Form Settings
   ========================================================================== */

if (btnEditConfig) {
  btnEditConfig.addEventListener('click', () => {
    configViewMode.style.display = 'none';
    configEditForm.style.display = 'flex';
    btnEditConfig.style.display = 'none';
  });
}

if (btnCancelConfig) {
  btnCancelConfig.addEventListener('click', () => {
    configViewMode.style.display = 'block';
    configEditForm.style.display = 'none';
    btnEditConfig.style.display = 'block';
    configEditForm.reset();
    if (activeAppObj) {
      editGitUrl.value = activeAppObj.git_url;
      editPort.value = activeAppObj.port;
      editAutoDeploy.checked = activeAppObj.auto_deploy || false;
      editCpuLimit.value = activeAppObj.cpu_limit || '';
      editMemLimit.value = activeAppObj.memory_limit || '';
    }
  });
}

if (configEditForm) {
  configEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const git_url = editGitUrl.value.trim();
    const port = parseInt(editPort.value, 10);
    const auto_deploy = editAutoDeploy.checked;
    const cpu_limit = editCpuLimit.value ? parseFloat(editCpuLimit.value) : null;
    const memory_limit = editMemLimit.value.trim() || null;
    
    const saveBtn = document.getElementById('btn-save-config');
    const originalText = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.innerHTML = `<span class="btn-spinner"></span> Saving...`;
    
    try {
      const payload = { git_url, port, auto_deploy, cpu_limit, memory_limit };
      const success = await updateAppConfiguration(payload);
      if (success) {
        btnCancelConfig.click();
        loadDetails();
      }
    } catch (err) {
      alert(err.message);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = originalText;
    }
  });
}

// Central API Request helper to update configuration
async function updateAppConfiguration(payload) {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/configure`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.detail || 'Configuration update failed');
    }
    return true;
  } catch (err) {
    alert(`Configuration Error: ${err.message}`);
    return false;
  }
}

// Auto deploy checkbox direct handler in View Mode
if (detailsAutoDeploy) {
  detailsAutoDeploy.onchange = async () => {
    const enabled = detailsAutoDeploy.checked;
    try {
      const success = await updateAppConfiguration({ auto_deploy: enabled });
      if (!success) {
        detailsAutoDeploy.checked = !enabled; // Revert
      } else {
        if (activeAppObj) activeAppObj.auto_deploy = enabled;
      }
    } catch (err) {
      detailsAutoDeploy.checked = !enabled;
    }
  };
}

/* ==========================================================================
   Lifecycle Controls
   ========================================================================== */

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

btnDetailsStart.onclick = () => runAction('start');
btnDetailsStop.onclick = () => runAction('stop');
btnDetailsRestart.onclick = () => runAction('restart');
btnDetailsDelete.onclick = deleteApp;

/* ==========================================================================
   Live Logs WebSocket Stream
   ========================================================================== */

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

/* ==========================================================================
   Live Telemetry Stats Polling & Insights
   ========================================================================== */

function startStatsPolling() {
  if (statsInterval) {
    clearInterval(statsInterval);
  }
  // Try loading cached stats for this app first
  try {
    const cached = localStorage.getItem('mini_heroku_stats_cache');
    if (cached) {
      const stats = JSON.parse(cached)[appName];
      if (stats && stats.status === 'running') {
        renderStatsUI(stats);
      }
    }
  } catch (e) {
    console.error("Error reading cached stats in details:", e);
  }
  pollStats();
  statsInterval = setInterval(pollStats, 3000);
}

async function pollStats() {
  try {
    const res = await authFetch(`${API_BASE}/api/apps/${appName}/stats`);
    if (!res.ok) return;
    const data = await res.json();

    // Check for auto-deploy transitions
    if (lastStatus && lastStatus !== 'building' && data.status === 'building' && data.auto_deploy) {
      showToastNotification(`New changes pushed for '${appName}'. New deployment in progress...`);
    }
    lastStatus = data.status;

    // Render alert banner if building
    const detailsAlertBanner = document.getElementById('details-alert-banner');
    if (data.status === 'building') {
      if (detailsAlertBanner) {
        detailsAlertBanner.innerHTML = `
          <div class="card-alert-banner" style="margin-top: 1rem; display: flex; align-items: center; gap: 0.4rem; padding: 0.8rem; border-radius: var(--radius-md); border: 1px solid rgba(37, 99, 235, 0.15); background-color: rgba(37, 99, 235, 0.05); color: var(--color-info); font-size: 0.88rem; font-weight: 600;">
            <span class="btn-spinner" style="border-top-color: currentColor; width: 14px; height: 14px; border-width: 1.5px; margin: 0;"></span>
            <span>New changes pushed. New deployment in progress...</span>
          </div>
        `;
      }
    } else {
      if (detailsAlertBanner) {
        detailsAlertBanner.innerHTML = '';
      }
    }

    // Render latest deployment time
    if (data.updated_at) {
      const detailsUpdatedAt = document.getElementById('details-updated-at');
      if (detailsUpdatedAt) {
        detailsUpdatedAt.textContent = new Date(data.updated_at).toLocaleString();
      }
    }

    renderStatsUI(data);

  } catch (err) {
    console.error('Stats error:', err);
  }
}

function renderStatsUI(data) {
  // Update insights
  if (insightIp) insightIp.textContent = data.ip_address || 'N/A';
  if (insightSize) insightSize.textContent = data.image_size_mb ? `${data.image_size_mb} MB` : 'N/A';
  if (insightRestarts) insightRestarts.textContent = data.restart_count !== undefined ? data.restart_count : 0;
  if (insightUptime) {
    if (data.status === 'running' && data.started_at) {
      insightUptime.textContent = formatUptime(data.started_at);
    } else {
      insightUptime.textContent = 'Offline';
    }
  }

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

    // Cache it
    try {
      const cached = localStorage.getItem('mini_heroku_stats_cache');
      const cacheObj = cached ? JSON.parse(cached) : {};
      cacheObj[appName] = {
        status: "running",
        cpu_percent: data.cpu_percent,
        memory_usage_mb: data.memory_usage_mb,
        memory_limit_mb: data.memory_limit_mb,
        memory_percent: data.memory_percent,
        ip_address: data.ip_address,
        image_size_mb: data.image_size_mb,
        started_at: data.started_at,
        restart_count: data.restart_count
      };
      localStorage.setItem('mini_heroku_stats_cache', JSON.stringify(cacheObj));
    } catch (e) {}
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

    try {
      const cached = localStorage.getItem('mini_heroku_stats_cache');
      if (cached) {
        const cacheObj = JSON.parse(cached);
        delete cacheObj[appName];
        localStorage.setItem('mini_heroku_stats_cache', JSON.stringify(cacheObj));
      }
    } catch (e) {}
  }
}

function formatUptime(startedAtStr) {
  if (!startedAtStr) return '--';
  const started = new Date(startedAtStr);
  const now = new Date();
  const diffMs = now - started;
  if (diffMs < 0) return 'Just started';
  
  const diffSecs = Math.floor(diffMs / 1000);
  const secs = diffSecs % 60;
  const diffMins = Math.floor(diffSecs / 60);
  const mins = diffMins % 60;
  const diffHours = Math.floor(diffMins / 60);
  const hours = diffHours % 24;
  const days = Math.floor(diffHours / 24);
  
  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (mins > 0 || hours > 0 || days > 0) parts.push(`${mins}m`);
  parts.push(`${secs}s`);
  
  return parts.join(' ');
}

function setBarColor(barElement, percentage) {
  barElement.classList.remove('warning', 'danger');
  if (percentage >= 85) {
    barElement.classList.add('danger');
  } else if (percentage >= 70) {
    barElement.classList.add('warning');
  }
}

// Copy Logs Action
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

// WebSocket Event channel listener
if (window.realtimeBridge) {
  window.realtimeBridge.subscribe((event) => {
    if (event.type === 'app_updated' && event.data.app_name === appName) {
      console.log("[Details] App updated in realtime:", event.data);
      renderDetails(event.data);
    }
  });
}

// Parse parameters on load
parseQuery();

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
