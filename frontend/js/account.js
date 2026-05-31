import { createClient } from '@supabase/supabase-js';

const API_BASE = window.location.origin;

// DOM Elements
const profileEmail = document.getElementById('profile-email');
const profileUsernameDisplay = document.getElementById('profile-username-display');
const profileProvider = document.getElementById('profile-provider');
const profileUid = document.getElementById('profile-uid');
const changePasswordForm = document.getElementById('change-password-form');
const changeSuccess = document.getElementById('change-success');
const changeError = document.getElementById('change-error');

let authMode = 'supabase';
let supabase = null;
let currentEmail = '';

async function loadAccountInfo() {
  const username = localStorage.getItem('mini_heroku_username') || 'Guest';
  if (profileUsernameDisplay) {
    profileUsernameDisplay.textContent = username.includes('@') ? '--' : username;
  }
  profileEmail.textContent = username.includes('@') ? username : '--';
  currentEmail = username;

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
}

function initializeSupabase(supabaseConfig) {
  if (!supabaseConfig) return;
  
  try {
    supabase = createClient(supabaseConfig.supabaseUrl, supabaseConfig.supabaseAnonKey);

    // Get current session and listen to changes
    supabase.auth.onAuthStateChange(async (event, session) => {
      if (session && session.user) {
        const user = session.user;
        currentEmail = user.email;
        profileEmail.textContent = user.email;
        profileProvider.textContent = 'Supabase Authentication';
        profileUid.textContent = user.id;
      } else {
        window.location.href = '/auth/login.html';
      }
    });
  } catch (e) {
    console.error("Supabase init failed in account:", e);
  }
}

async function loadProfileInfo() {
  try {
    const res = await authFetch(`${API_BASE}/api/auth/profile`);
    if (res.ok) {
      const data = await res.json();
      if (data.email) {
        profileEmail.textContent = data.email;
        currentEmail = data.email;
      }
      if (data.username) {
        localStorage.setItem('mini_heroku_username', data.username);
        const headerUsername = document.getElementById('header-username');
        if (headerUsername) {
          headerUsername.textContent = data.username;
        }
        if (profileUsernameDisplay) {
          profileUsernameDisplay.textContent = data.username;
        }
      }
    }
  } catch (err) {
    console.error('Failed to load profile details:', err);
  }
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
        // Local auth password change
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
loadProfileInfo();
