// Authentication check helper running in head before body render to prevent content flash
(function () {
  const token = localStorage.getItem('mini_heroku_token');
  const profileCompleted = localStorage.getItem('mini_heroku_profile_completed');
  const isLoginPage = window.location.pathname.endsWith('login.html');
  
  if (!isLoginPage) {
    if (!token) {
      window.location.replace('login.html');
    } else if (!profileCompleted) {
      window.location.replace('login.html');
    }
  } else if (token && profileCompleted && isLoginPage) {
    // If logout action is passed, clear it instead of redirecting
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') !== 'logout') {
      window.location.replace('index.html');
    }
  }
})();

// Global session termination
function handleUnauthorized() {
  localStorage.removeItem('mini_heroku_token');
  localStorage.removeItem('mini_heroku_username');
  localStorage.removeItem('mini_heroku_profile_completed');
  window.location.replace('login.html');
}

// Global authenticated fetch utility
async function authFetch(url, options = {}) {
  const token = localStorage.getItem('mini_heroku_token');
  if (!options.headers) {
    options.headers = {};
  }
  if (token) {
    options.headers['Authorization'] = `Bearer ${token}`;
  }
  
  const response = await fetch(url, options);
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error('Session expired or unauthorized.');
  }
  return response;
}


// Dynamically render common header navbar on DOM load
document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('app-header');
  if (!header) return;

  const username = localStorage.getItem('mini_heroku_username') || 'Guest';
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  // SVG Icons for Nav Link tabs
  const dashboardIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`;
  const deploymentsIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
  const accountIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

  header.innerHTML = `
    <div class="header-container">
      <div class="logo-group">
        <div class="logo-icon">▲</div>
        <div class="logo-text">
          <h1>Mini-Heroku</h1>
          <span>Local PaaS Orchestrator</span>
        </div>
      </div>
      
      <nav class="header-nav">
        <a href="index.html" class="nav-link ${currentPage === 'index.html' || currentPage === '' ? 'active' : ''}">${dashboardIcon}<span>Dashboard</span></a>
        <a href="apps.html" class="nav-link ${currentPage === 'apps.html' || currentPage === 'app-details.html' ? 'active' : ''}">${deploymentsIcon}<span>Deployments</span></a>
        <a href="account.html" class="nav-link ${currentPage === 'account.html' ? 'active' : ''}">${accountIcon}<span>Account</span></a>
      </nav>

      <div class="header-right">
        <div class="header-status">
          <span class="status-indicator online"></span>
          <span class="status-label">Daemon: Active</span>
        </div>
        <div class="user-profile" id="user-profile">
          <span id="header-username" class="username-display">${username}</span>
          <button id="btn-logout" class="btn btn-secondary btn-sm">Log Out</button>
        </div>
      </div>
    </div>
  `;

  // Bind logo click to home
  header.querySelector('.logo-group').addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Bind logout action
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      localStorage.removeItem('mini_heroku_token');
      localStorage.removeItem('mini_heroku_username');
      localStorage.removeItem('mini_heroku_profile_completed');
      window.location.replace('login.html?action=logout');
    });
  }
});
