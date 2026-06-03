import { createClient } from '@supabase/supabase-js';

const API_BASE = window.location.origin;

// DOM Elements
const profileEmail = document.getElementById('profile-email-header');
const profileUsernameDisplay = document.getElementById('profile-display-name-header');
const profileProvider = document.getElementById('profile-provider');
const profileUid = document.getElementById('profile-uid');
const changePasswordForm = document.getElementById('change-password-form');
const changeSuccess = document.getElementById('change-success');
const changeError = document.getElementById('change-error');

const profileEditForm = document.getElementById('profile-edit-form');
const profileUsernameInput = document.getElementById('profile-username');
const profileFullnameInput = document.getElementById('profile-fullname');
const profileCompanyInput = document.getElementById('profile-company');
const profileUseCaseSelect = document.getElementById('profile-use-case');
const profileSuccess = document.getElementById('profile-success');
const profileError = document.getElementById('profile-error');

const quotaAppsCount = document.getElementById('quota-apps-count');
const quotaAppsBar = document.getElementById('quota-apps-bar');
const quotaMemoryCount = document.getElementById('quota-memory-count');
const quotaMemoryBar = document.getElementById('quota-memory-bar');

const themeSelector = document.getElementById('theme-selector');
const btnDeactivateSession = document.getElementById('btn-deactivate-session');
const btnUpgradeMock = document.getElementById('btn-upgrade-mock');

let authMode = 'supabase';
let supabase = null;
let currentEmail = '';

async function loadAccountInfo() {
  // Load cached profile data if available
  const cachedProfile = AppCache.get('vessel_user_profile_cache');
  if (cachedProfile) {
    renderProfileUI(cachedProfile);
  }

  // Fetch auth config
  try {
    const res = await fetch(`${API_BASE}/api/auth/config`);
    if (!res.ok) throw new Error('Failed to load auth config');
    const config = await res.json();
    authMode = config.auth_mode;

    if (authMode === 'supabase') {
      initializeSupabase(config.supabase_config);
    } else {
      profileProvider.textContent = 'Local SQLite Database';
      profileUid.textContent = 'Local Session';
    }
  } catch (err) {
    console.error('Error fetching config:', err);
    profileProvider.textContent = 'Local Dev Override';
    profileUid.textContent = 'Local Session';
  }

  // Load Quotas
  renderQuotas();
  
  // Background SWR fetch
  loadProfileInfo();
}

function initializeSupabase(supabaseConfig) {
  if (!supabaseConfig) return;
  
  try {
    supabase = createClient(supabaseConfig.supabaseUrl, supabaseConfig.supabaseAnonKey);

    supabase.auth.onAuthStateChange(async (event, session) => {
      if (session && session.user) {
        const user = session.user;
        currentEmail = user.email;
        if (profileEmail) profileEmail.textContent = user.email;
        if (profileProvider) profileProvider.textContent = 'Supabase Authentication';
        if (profileUid) profileUid.textContent = user.id;
      } else {
        window.location.href = '/auth/login.html';
      }
    });
  } catch (e) {
    console.error("Supabase init failed in account:", e);
  }
}

async function loadProfileInfo() {
  swrFetch(`${API_BASE}/api/auth/profile`, 'vessel_user_profile_cache', (data) => {
    renderProfileUI(data);
  });
}

function renderProfileUI(data) {
  if (data.email) {
    if (profileEmail) profileEmail.textContent = data.email;
    currentEmail = data.email;
  }
  
  const displayName = data.name || data.username || 'User Profile';
  if (profileUsernameDisplay) {
    profileUsernameDisplay.textContent = displayName;
  }
  
  // Set avatar initials
  const avatarLetters = document.getElementById('profile-avatar-letters');
  if (avatarLetters) {
    avatarLetters.textContent = displayName.substring(0, 2).toUpperCase();
  }

  if (profileUsernameInput) profileUsernameInput.value = data.username || '';
  if (profileFullnameInput) profileFullnameInput.value = data.name || '';
  if (profileCompanyInput) profileCompanyInput.value = data.company || '';
  if (profileUseCaseSelect) profileUseCaseSelect.value = data.use_case || 'Personal';

  if (data.save_history !== undefined) {
    const checkbox = document.getElementById('profile-save-history');
    if (checkbox) {
      checkbox.checked = data.save_history;
    }
  }
  
  // Cache username in localStorage for navbar sync
  if (data.username) {
    localStorage.setItem('mini_heroku_username', data.username);
    const headerUsername = document.getElementById('header-username');
    if (headerUsername) {
      headerUsername.textContent = data.username;
    }
  }
}

function renderQuotas() {
  try {
    const cachedApps = AppCache.get('mini_heroku_deployments_cache') || [];
    const appCount = cachedApps.length;
    
    // Services Quota (Max 5)
    if (quotaAppsCount) quotaAppsCount.textContent = `${appCount} / 5 Services`;
    if (quotaAppsBar) quotaAppsBar.style.width = `${Math.min((appCount / 5) * 100, 100)}%`;

    // Memory Quota (Max 2048MB)
    let totalMem = 0;
    cachedApps.forEach(app => {
      let limit = app.memory_limit || '512m';
      limit = limit.toLowerCase();
      if (limit.endsWith('g')) {
        totalMem += parseInt(limit, 10) * 1024;
      } else {
        totalMem += parseInt(limit, 10) || 512;
      }
    });
    
    if (quotaMemoryCount) quotaMemoryCount.textContent = `${totalMem} MB / 2048 MB`;
    if (quotaMemoryBar) quotaMemoryBar.style.width = `${Math.min((totalMem / 2048) * 100, 100)}%`;
  } catch (e) {
    console.error("Failed to render quotas:", e);
  }
}

// Bind Profile Save Form
if (profileEditForm) {
  profileEditForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const username = profileUsernameInput.value.trim().toLowerCase();
    const name = profileFullnameInput.value.trim();
    const company = profileCompanyInput.value.trim() || null;
    const use_case = profileUseCaseSelect.value;

    const btnSave = document.getElementById('btn-save-profile');
    const originalText = btnSave.textContent;
    btnSave.disabled = true;
    btnSave.innerHTML = `<span class="btn-spinner"></span> Saving...`;

    if (profileSuccess) profileSuccess.classList.add('hidden');
    if (profileError) profileError.classList.add('hidden');

    try {
      const res = await authFetch(`${API_BASE}/api/auth/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, name, company, use_case })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Profile update failed');

      profileSuccess.textContent = "Profile information updated successfully!";
      profileSuccess.classList.remove('hidden');
      
      // Update cache
      const cached = AppCache.get('vessel_user_profile_cache') || {};
      const updated = { ...cached, username, name, company, use_case };
      AppCache.set('vessel_user_profile_cache', updated);
      renderProfileUI(updated);

      setTimeout(() => profileSuccess.classList.add('hidden'), 4000);
    } catch (err) {
      profileError.textContent = err.message;
      profileError.classList.remove('hidden');
    } finally {
      btnSave.disabled = false;
      btnSave.textContent = originalText;
    }
  });
}

// Bind history saving preference change
const historyCheckbox = document.getElementById('profile-save-history');
if (historyCheckbox) {
  historyCheckbox.addEventListener('change', async () => {
    try {
      const res = await authFetch(`${API_BASE}/api/auth/profile/history-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ save_history: historyCheckbox.checked })
      });
      if (!res.ok) {
        throw new Error('Failed to update history preferences');
      }
      
      // Update profile cache
      const cached = AppCache.get('vessel_user_profile_cache') || {};
      cached.save_history = historyCheckbox.checked;
      AppCache.set('vessel_user_profile_cache', cached);
    } catch (err) {
      console.error(err);
      alert('Error updating history preferences: ' + err.message);
      historyCheckbox.checked = !historyCheckbox.checked;
    }
  });
}

// Color Theme Selector
if (themeSelector) {
  const currentTheme = localStorage.getItem('vessel_color_theme') || 'light';
  themeSelector.value = currentTheme;
  
  themeSelector.addEventListener('change', () => {
    const selectedTheme = themeSelector.value;
    localStorage.setItem('vessel_color_theme', selectedTheme);
    document.documentElement.setAttribute('data-theme', selectedTheme);
  });
}

// Mock Billing Upgrade
if (btnUpgradeMock) {
  btnUpgradeMock.addEventListener('click', (e) => {
    e.preventDefault();
    alert("Vessel Enterprise billing integrations are mocked for this demonstration. Sandbox constraints apply.");
  });
}

// Danger Zone: Reset account & session
if (btnDeactivateSession) {
  btnDeactivateSession.addEventListener('click', () => {
    if (confirm("Are you sure you want to log out and clear all cached dashboard profiles? This will reset your active session.")) {
      localStorage.clear();
      window.location.replace('/auth/login.html?action=logout');
    }
  });
}

// Bind password change form
if (changePasswordForm) {
  changePasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPassword = document.getElementById('change-new-password').value;
    const confirmPassword = document.getElementById('change-confirm-password').value;
    
    const btnSubmit = document.getElementById('btn-submit-change-password');
    btnSubmit.disabled = true;
    const originalText = btnSubmit.textContent;
    btnSubmit.innerHTML = `<span class="btn-spinner"></span> Updating...`;
    
    if (changeSuccess) changeSuccess.classList.add('hidden');
    if (changeError) changeError.classList.add('hidden');
    
    if (newPassword.length < 6) {
      changeError.textContent = "Password must be at least 6 characters long.";
      changeError.classList.remove('hidden');
      btnSubmit.disabled = false;
      btnSubmit.textContent = originalText;
      return;
    }
    
    if (newPassword !== confirmPassword) {
      changeError.textContent = "Passwords do not match.";
      changeError.classList.remove('hidden');
      btnSubmit.disabled = false;
      btnSubmit.textContent = originalText;
      return;
    }
    
    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline.");
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) throw error;
        
        changeSuccess.textContent = "Password updated successfully!";
        changeSuccess.classList.remove('hidden');
        changePasswordForm.reset();
      } else {
        const token = localStorage.getItem('mini_heroku_token');
        const res = await fetch(`${API_BASE}/api/auth/change-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
          },
          body: JSON.stringify({ password: newPassword })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Failed to update password.");
        
        changeSuccess.textContent = "Password updated successfully!";
        changeSuccess.classList.remove('hidden');
        changePasswordForm.reset();
      }
    } catch (err) {
      changeError.textContent = err.message;
      changeError.classList.remove('hidden');
    } finally {
      btnSubmit.disabled = false;
      btnSubmit.textContent = originalText;
    }
  });
}

loadAccountInfo();
