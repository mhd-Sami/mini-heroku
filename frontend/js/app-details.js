const API_BASE = window.location.origin;
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_BASE = `${wsProtocol}//${window.location.host}`;

// State
let appName = '';
let detailsSocket = null;
let statsInterval = null;
let lastStatus = ''; // Track last status to detect auto-deployment transitions

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
const btnDetailsClearLogs = document.getElementById('btn-details-clear-logs');
const btnDetailsStart = document.getElementById('btn-details-start');
const btnDetailsStop = document.getElementById('btn-details-stop');
const btnDetailsRestart = document.getElementById('btn-details-restart');
const btnDetailsDelete = document.getElementById('btn-details-delete');

const routingSubdomain = document.getElementById('routing-subdomain');
const routingRule = document.getElementById('routing-rule');
const routingBalancer = document.getElementById('routing-balancer');

// Parse Query Parameters
function parseQuery() {
  const params = new URLSearchParams(window.location.search);
  appName = params.get('app');
  if (!appName) {
    window.location.href = 'apps.html';
    return;
  }
  loadCachedDetails();
  loadDetails();
}

function loadCachedDetails() {
  const cached = localStorage.getItem('mini_heroku_deployments_cache');
  if (cached) {
    try {
      const apps = JSON.parse(cached);
      const app = apps.find(d => d.app_name === appName);
      if (app) {
        renderDetails(app);
      }
    } catch (e) {
      console.error("Failed to parse cached details:", e);
    }
  }
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
  lastStatus = app.status;
  detailsAppName.textContent = app.app_name;
  detailsAppLink.href = getAppUrl(app.app_name);
  detailsAppLink.textContent = getAppUrlDisplay(app.app_name);
  
  detailsStatusBadge.className = `status-badge ${app.status}`;
  detailsStatusText.textContent = app.status;

  detailsGitUrl.textContent = app.git_url;
  detailsPort.textContent = app.port;
  detailsCpuLimit.textContent = app.cpu_limit ? `${app.cpu_limit} Cores` : 'None';
  detailsMemLimit.textContent = app.memory_limit || 'None';
  detailsCreatedAt.textContent = new Date(app.created_at).toLocaleString();
  if (detailsUpdatedAt) {
    detailsUpdatedAt.textContent = new Date(app.updated_at || app.created_at).toLocaleString();
  }

  // Render metadata badges
  const detailsMetaBadges = document.getElementById('details-meta-badges');
  if (detailsMetaBadges) {
    detailsMetaBadges.innerHTML = '';
    if (app.last_commit_hash) {
      const gitBadge = document.createElement('span');
      gitBadge.className = 'badge-tag badge-git';
      gitBadge.title = 'Last Deployed Commit';
      gitBadge.style.cssText = 'display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; font-family: var(--font-family-mono); background: var(--color-bg-cream); border: 1px solid var(--color-bg-alt); padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); color: var(--color-primary-light); font-weight: 600;';
      gitBadge.innerHTML = `
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="git-icon"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
        ${app.last_commit_hash.substring(0, 7)}
      `;
      detailsMetaBadges.appendChild(gitBadge);
    }
    if (app.auto_deploy) {
      const autoBadge = document.createElement('span');
      autoBadge.className = 'badge-tag badge-auto-deploy-tag pulsing-dot-tag';
      autoBadge.title = 'Auto-Deploy Active';
      autoBadge.style.cssText = 'display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.2); padding: 0.2rem 0.5rem; border-radius: var(--radius-sm); color: var(--color-success); font-weight: 600;';
      autoBadge.innerHTML = `
        <span class="pulse-dot" style="background-color: var(--color-success); width: 6px; height: 6px; position: static; transform: none; display: inline-block; margin-right: 0.2rem;"></span>
        Auto-Deploy
      `;
      detailsMetaBadges.appendChild(autoBadge);
    }
  }

  // Render routing configuration details
  if (routingSubdomain) {
    routingSubdomain.href = getAppUrl(app.app_name);
    routingSubdomain.textContent = getAppUrlDisplay(app.app_name);
  }
  if (routingRule) {
    routingRule.textContent = `Host(\`${app.app_name}.localhost\`) || HostRegexp(\`^${app.app_name}\\\\.\`)`;
  }
  if (routingBalancer) {
    routingBalancer.textContent = `Internal Port ${app.port}`;
  }

  if (detailsAutoDeploy) {
    detailsAutoDeploy.checked = app.auto_deploy || false;
    detailsAutoDeploy.onchange = async () => {
      const enabled = detailsAutoDeploy.checked;
      try {
        const res = await authFetch(`${API_BASE}/api/apps/${appName}/auto-deploy`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled })
        });
        if (!res.ok) throw new Error("Failed to update auto-deployment setting");
        const result = await res.json();
        console.log("Auto-deploy setting updated to:", result.auto_deploy);
      } catch (err) {
        alert(err.message);
        detailsAutoDeploy.checked = !enabled; // Revert checkbox
      }
    };
  }

  // Render environment variables
  detailsEnvList.innerHTML = '';
  const envKeys = Object.keys(app.env_vars || {});
  if (envKeys.length === 0) {
    detailsEnvList.innerHTML = '<div style="font-size: 0.85rem; color: var(--color-text-muted);">No environment variables configured.</div>';
  } else {
    envKeys.forEach(key => {
      const item = document.createElement('div');
      item.className = 'env-item';
      item.style.cssText = 'display: flex; justify-content: space-between; align-items: center; background-color: var(--color-bg-cream); padding: 0.5rem 0.75rem; border-radius: var(--radius-sm); font-size: 0.8rem; font-family: var(--font-family-mono); border: 1px solid var(--color-bg-alt); margin-bottom: 0.5rem;';
      
      const rawValue = app.env_vars[key];
      const maskedValue = '••••••••';
      
      item.innerHTML = `
        <span class="env-key" style="color: var(--color-primary-light); font-weight: 600;">${key}</span>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span class="env-val" id="env-val-${key}" style="color: var(--color-text-main); font-weight: 600;">${maskedValue}</span>
          <button type="button" class="btn-toggle-env" style="background: none; border: none; cursor: pointer; color: var(--color-text-muted); padding: 0 0.2rem; display: flex; align-items: center;" title="Show/Hide Value">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
      `;
      
      const toggleBtn = item.querySelector('.btn-toggle-env');
      const valSpan = item.querySelector('.env-val');
      toggleBtn.onclick = () => {
        const isMasked = valSpan.textContent === maskedValue;
        valSpan.textContent = isMasked ? rawValue : maskedValue;
        toggleBtn.innerHTML = isMasked 
          ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eye-icon"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
          : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="eye-icon"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
      };
      
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

  // Stream Logs if not already connected
  if (!detailsSocket) {
    connectLogs();
  }

  // Poll Stats if not already polling
  if (!statsInterval) {
    startStatsPolling();
  }
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
  // Try loading cached stats for this app first
  try {
    const cached = localStorage.getItem('mini_heroku_stats_cache');
    if (cached) {
      const stats = JSON.parse(cached)[appName];
      if (stats && stats.status === 'running') {
        if (detailsCpuVal) detailsCpuVal.textContent = `${stats.cpu_percent}%`;
        if (detailsCpuBar) {
          detailsCpuBar.style.width = `${Math.min(stats.cpu_percent, 100)}%`;
          setBarColor(detailsCpuBar, stats.cpu_percent);
        }
        if (detailsMemVal) detailsMemVal.textContent = `${stats.memory_usage_mb}MB / ${stats.memory_limit_mb}MB`;
        if (detailsMemBar) {
          detailsMemBar.style.width = `${stats.memory_percent}%`;
          setBarColor(detailsMemBar, stats.memory_percent);
        }
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

      // Update the cache as well!
      try {
        const cached = localStorage.getItem('mini_heroku_stats_cache');
        const cacheObj = cached ? JSON.parse(cached) : {};
        cacheObj[appName] = {
          status: "running",
          cpu_percent: data.cpu_percent,
          memory_usage_mb: data.memory_usage_mb,
          memory_limit_mb: data.memory_limit_mb,
          memory_percent: data.memory_percent
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

      // Remove from cache or set as stopped
      try {
        const cached = localStorage.getItem('mini_heroku_stats_cache');
        if (cached) {
          const cacheObj = JSON.parse(cached);
          delete cacheObj[appName];
          localStorage.setItem('mini_heroku_stats_cache', JSON.stringify(cacheObj));
        }
      } catch (e) {}
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

// Clear Logs
if (btnDetailsClearLogs) {
  btnDetailsClearLogs.onclick = () => {
    detailsTerminal.innerHTML = '';
  };
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
