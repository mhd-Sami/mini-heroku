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
    
    metricTotalApps.textContent = deployments.length;
    const runningCount = deployments.filter(d => d.status === 'running').length;
    metricRunningApps.textContent = runningCount;
  } catch (err) {
    console.error('Error fetching metrics:', err);
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
fetchMetrics();
