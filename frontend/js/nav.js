// Authentication check helper running in head before body render to prevent content flash
(function () {
  const token = localStorage.getItem('mini_heroku_token');
  const profileCompleted = localStorage.getItem('mini_heroku_profile_completed');
  const isAuthPage = window.location.pathname.includes('/auth/');
  
  // Check if current URL contains Supabase auth parameters (callback context)
  const hasAuthParams = window.location.hash.includes('access_token=') || 
                        window.location.hash.includes('id_token=') ||
                        window.location.hash.includes('error=') ||
                        window.location.search.includes('code=') ||
                        window.location.search.includes('type=signup') ||
                        window.location.hash.includes('type=signup') ||
                        window.location.hash.includes('type=recovery');

  if (hasAuthParams) {
    if (!isAuthPage) {
      // Redirect to the login page preserving the auth credentials in hash/query params
      // so that Supabase client can initialize and parse the session.
      window.location.replace('/auth/login.html' + window.location.search + window.location.hash);
    }
    return; // Bypass any further checks to let the page or the login portal process auth
  }

  if (!isAuthPage) {
    if (!token) {
      window.location.replace('/auth/login.html');
    } else if (!profileCompleted) {
      window.location.replace('/auth/profile.html');
    }
  } else {
    // If we are on an auth page, redirect if already logged in and profile completed
    if (token && profileCompleted) {
      const params = new URLSearchParams(window.location.search);
      if (params.get('action') !== 'logout' && !window.location.pathname.includes('reset-password.html')) {
        window.location.replace('/index.html');
      }
    }
  }
})();


// Dynamic routing URL helpers
window.getAppUrl = function(appName) {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `http://${appName}.localhost`;
  }
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipRegex.test(hostname)) {
    return `http://${appName}.${hostname}.nip.io`;
  }
  return `http://${appName}.${hostname}`;
};

window.getAppUrlDisplay = function(appName) {
  const hostname = window.location.hostname;
  if (hostname === 'localhost' || hostname === '127.0.0.1') {
    return `${appName}.localhost`;
  }
  const ipRegex = /^(\d{1,3}\.){3}\d{1,3}$/;
  if (ipRegex.test(hostname)) {
    return `${appName}.${hostname}.nip.io`;
  }
  return `${appName}.${hostname}`;
};

// Global session termination
function handleUnauthorized() {
  localStorage.removeItem('mini_heroku_token');
  localStorage.removeItem('mini_heroku_username');
  localStorage.removeItem('mini_heroku_profile_completed');
  window.location.replace('/auth/login.html');
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
window.refreshNavBadge = function() {
  const cached = localStorage.getItem('mini_heroku_deployments_cache');
  let count = 0;
  if (cached) {
    try {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr)) count = arr.length;
    } catch (e) {}
  }
  const badgeEl = document.querySelector('.nav-badge');
  if (badgeEl) {
    if (count > 0) {
      badgeEl.textContent = count;
      badgeEl.style.display = 'inline-flex';
    } else {
      badgeEl.style.display = 'none';
    }
  } else if (count > 0) {
    const deploymentsLink = document.querySelector('a[href="apps.html"]');
    if (deploymentsLink) {
      const span = document.createElement('span');
      span.className = 'nav-badge';
      span.textContent = count;
      deploymentsLink.appendChild(span);
    }
  }
};

document.addEventListener('DOMContentLoaded', () => {
  const header = document.getElementById('app-header');
  if (!header) return;

  const username = localStorage.getItem('mini_heroku_username') || 'Guest';
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  // SVG Icons for Nav Link tabs
  const dashboardIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`;
  const deploymentsIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
  const accountIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

  // Resolve deployment count badge from localStorage cache
  const cached = localStorage.getItem('mini_heroku_deployments_cache');
  let deploymentsCount = 0;
  if (cached) {
    try {
      const arr = JSON.parse(cached);
      if (Array.isArray(arr)) deploymentsCount = arr.length;
    } catch (e) {}
  }
  const countBadge = deploymentsCount > 0 ? `<span class="nav-badge">${deploymentsCount}</span>` : '';

  header.innerHTML = `
    <div class="header-container">
      <div class="logo-group">
        <img src="assets/nobg-vessel-default-2.png" alt="Vessel Logo" style="height: 38px; width: auto; object-fit: contain;">
        <div class="logo-text">
          <h1>Vessel</h1>
          <span>Enterprise PaaS</span>
        </div>
      </div>
      
      <nav class="header-nav">
        <a href="index.html" class="nav-link ${currentPage === 'index.html' || currentPage === '' ? 'active' : ''}">${dashboardIcon}<span>Dashboard</span></a>
        <a href="apps.html" class="nav-link ${currentPage === 'apps.html' || currentPage === 'app-details.html' ? 'active' : ''}">${deploymentsIcon}<span>Deployments</span>${countBadge}</a>
        <a href="account.html" class="nav-link ${currentPage === 'account.html' ? 'active' : ''}">${accountIcon}<span>Account</span></a>
      </nav>

      <div class="header-right">
        <!-- Shortcut New App call to action button -->
        <a href="index.html?action=deploy" class="btn-nav-deploy" title="Deploy a new service">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          <span>New App</span>
        </a>
        <div class="header-status">
          <span class="status-indicator online"></span>
          <span class="status-label">Daemon: Active</span>
        </div>
        <div class="user-profile" id="user-profile">
          <span id="header-username" class="username-display">${username}</span>
          <button id="btn-logout" class="btn btn-logout-nav btn-sm">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="logout-icon"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            <span>Log Out</span>
          </button>
        </div>
      </div>
    </div>
  `;

  // Bind logo click to home
  header.querySelector('.logo-group').addEventListener('click', () => {
    window.location.href = '/index.html';
  });

  // Bind logout action
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      localStorage.removeItem('mini_heroku_token');
      localStorage.removeItem('mini_heroku_username');
      localStorage.removeItem('mini_heroku_profile_completed');
      window.location.replace('/auth/login.html?action=logout');
    });
  }
});
