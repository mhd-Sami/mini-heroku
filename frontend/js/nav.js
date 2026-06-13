// Authentication check helper running in head before body render to prevent content flash
(function () {
  const savedTheme = localStorage.getItem('vessel_color_theme') || 'light';
  document.documentElement.setAttribute('data-theme', savedTheme);

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

/* ==========================================================================
   VESSEL CLIENT CACHE & REAL-TIME EVENT BRIDGE
   ========================================================================== */

const AppCache = {
  get(key) {
    try {
      const data = localStorage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      return null;
    }
  },
  set(key, val) {
    try {
      localStorage.setItem(key, JSON.stringify(val));
    } catch (e) {}
  },
  remove(key) {
    localStorage.removeItem(key);
  }
};

async function swrFetch(url, cacheKey, onUpdate, options = {}) {
  // 1. Instantly return cached copy to DOM
  const cachedData = AppCache.get(cacheKey);
  if (cachedData !== null) {
    onUpdate(cachedData, true);
  }

  // 2. Fetch fresh data in the background
  try {
    const res = await authFetch(url, options);
    if (res.ok) {
      const freshData = await res.json();
      const cachedStr = JSON.stringify(cachedData);
      const freshStr = JSON.stringify(freshData);
      if (cachedStr !== freshStr) {
        AppCache.set(cacheKey, freshData);
        onUpdate(freshData, false);
      }
    }
  } catch (err) {
    console.error(`SWR background fetch failed for ${url}:`, err);
  }
}

// Real-time Event Pub/Sub Bridge
window.realtimeBridge = {
  listeners: [],
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  },
  broadcast(event) {
    this.listeners.forEach(cb => {
      try {
        cb(event);
      } catch (e) {
        console.error("Error in realtime listener:", e);
      }
    });
  }
};

function connectRealtimeWS() {
  const token = localStorage.getItem('mini_heroku_token');
  if (!token) return;

  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsHost = window.location.host;
  const socketUrl = `${wsProtocol === 'wss:' ? 'wss:' : 'ws:'}//${wsHost}/ws/events?token=${encodeURIComponent(token)}`;
  
  const ws = new WebSocket(socketUrl);
  
  ws.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      console.log("[Realtime WS] Received event:", payload);
      
      // Update local storage cache in-place
      handleRealtimeEvent(payload);
      
      // Broadcast to page listeners
      window.realtimeBridge.broadcast(payload);
    } catch (e) {
      console.error("[Realtime WS] Error parsing message:", e);
    }
  };
  
  ws.onclose = () => {
    console.log("[Realtime WS] Disconnected. Reconnecting in 3 seconds...");
    setTimeout(connectRealtimeWS, 3000);
  };
  
  ws.onerror = (err) => {
    console.error("[Realtime WS] Socket error:", err);
  };
}

window.updateDeploymentsCache = function(updatedApp) {
  try {
    const cached = localStorage.getItem('mini_heroku_deployments_cache');
    let deployments = cached ? JSON.parse(cached) : [];
    if (!Array.isArray(deployments)) deployments = [];
    const idx = deployments.findIndex(d => d.app_name === updatedApp.app_name);
    if (idx !== -1) {
      deployments[idx] = updatedApp;
    } else {
      deployments.push(updatedApp);
    }
    localStorage.setItem('mini_heroku_deployments_cache', JSON.stringify(deployments));
    if (typeof window.refreshNavBadge === 'function') {
      window.refreshNavBadge();
    }
  } catch (e) {
    console.error("Failed to update deployments cache:", e);
  }
};

function handleRealtimeEvent(payload) {
  const { type, data } = payload;
  if (type === 'app_updated') {
    try {
      window.updateDeploymentsCache(data);
      
      // Also update stats cache if status changed to non-running
      if (data.status !== 'running') {
        const statsCached = localStorage.getItem('mini_heroku_stats_cache');
        if (statsCached) {
          const stats = JSON.parse(statsCached);
          delete stats[data.app_name];
          localStorage.setItem('mini_heroku_stats_cache', JSON.stringify(stats));
        }
      }
    } catch (e) {
      console.error("Failed to update cache on app_updated:", e);
    }
  } else if (type === 'app_deleted') {
    try {
      const cached = localStorage.getItem('mini_heroku_deployments_cache');
      let deployments = cached ? JSON.parse(cached) : [];
      if (Array.isArray(deployments)) {
        deployments = deployments.filter(d => d.app_name !== data.app_name);
        localStorage.setItem('mini_heroku_deployments_cache', JSON.stringify(deployments));
      }
      
      // Remove from stats cache
      const statsCached = localStorage.getItem('mini_heroku_stats_cache');
      if (statsCached) {
        const stats = JSON.parse(statsCached);
        delete stats[data.app_name];
        localStorage.setItem('mini_heroku_stats_cache', JSON.stringify(stats));
      }
    } catch (e) {
      console.error("Failed to update cache on app_deleted:", e);
    }
  } else if (type === 'history_added') {
    try {
      const cached = localStorage.getItem('mini_heroku_history_cache');
      let history = cached ? JSON.parse(cached) : [];
      if (!Array.isArray(history)) history = [];
      if (!history.some(h => h.id === data.id)) {
        history.unshift(data);
        localStorage.setItem('mini_heroku_history_cache', JSON.stringify(history));
      }
    } catch (e) {
      console.error("Failed to update history cache on history_added:", e);
    }
  } else if (type === 'history_deleted') {
    try {
      const cached = localStorage.getItem('mini_heroku_history_cache');
      let history = cached ? JSON.parse(cached) : [];
      if (Array.isArray(history)) {
        history = history.filter(h => h.id !== data.id);
        localStorage.setItem('mini_heroku_history_cache', JSON.stringify(history));
      }
    } catch (e) {
      console.error("Failed to update history cache on history_deleted:", e);
    }
  } else if (type === 'history_cleared') {
    localStorage.setItem('mini_heroku_history_cache', JSON.stringify([]));
  }
}

// Auto-start connection on page load if user token exists
if (localStorage.getItem('mini_heroku_token')) {
  setTimeout(connectRealtimeWS, 100);
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

window.renderHeader = function() {
  const header = document.getElementById('app-header');
  if (!header) return;

  const username = localStorage.getItem('mini_heroku_username') || 'Guest';
  const currentPage = window.location.pathname.split('/').pop() || 'index.html';

  // SVG Icons for Nav Link tabs
  const dashboardIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`;
  const deploymentsIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`;
  const accountIcon = `<svg class="nav-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

  const hasStaticShell = header.querySelector('.header-container') !== null;
  if (!hasStaticShell) {
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
          <a href="index.html" class="nav-link">${dashboardIcon}<span>Dashboard</span></a>
          <a href="apps.html" class="nav-link">${deploymentsIcon}<span>Deployments</span></a>
          <a href="account.html" class="nav-link">${accountIcon}<span>Account</span></a>
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
  }

  // Update active states
  const navLinks = header.querySelectorAll('.header-nav a');
  navLinks.forEach(link => {
    const href = link.getAttribute('href');
    if (href === 'index.html' && (currentPage === 'index.html' || currentPage === '')) {
      link.classList.add('active');
    } else if (href === 'apps.html' && (currentPage === 'apps.html' || currentPage === 'app-details.html')) {
      link.classList.add('active');
    } else if (href === 'account.html' && currentPage === 'account.html') {
      link.classList.add('active');
    } else {
      link.classList.remove('active');
    }
  });

  // Update dynamic elements
  const usernameDisplay = header.querySelector('#header-username');
  if (usernameDisplay) {
    usernameDisplay.textContent = username;
  }

  window.refreshNavBadge();

  // Bind logo click to home
  const logoGroup = header.querySelector('.logo-group');
  if (logoGroup) {
    logoGroup.onclick = () => {
      window.location.href = '/index.html';
    };
  }

  // Bind logout action
  const btnLogout = document.getElementById('btn-logout');
  if (btnLogout) {
    btnLogout.onclick = () => {
      localStorage.removeItem('mini_heroku_token');
      localStorage.removeItem('mini_heroku_username');
      localStorage.removeItem('mini_heroku_profile_completed');
      window.location.replace('/auth/login.html?action=logout');
    };
  }
};

document.addEventListener('DOMContentLoaded', () => {
  window.renderHeader();
});
