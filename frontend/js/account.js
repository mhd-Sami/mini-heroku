import { createClient } from '@supabase/supabase-js';

const API_BASE = window.location.origin;

// DOM Elements
const profileEmail = document.getElementById('profile-email');
const profileProvider = document.getElementById('profile-provider');
const profileUid = document.getElementById('profile-uid');
const btnTriggerReset = document.getElementById('btn-trigger-reset');
const resetSuccess = document.getElementById('reset-success');
const resetError = document.getElementById('reset-error');

let authMode = 'supabase';
let supabase = null;
let currentEmail = '';

async function loadAccountInfo() {
  const username = localStorage.getItem('mini_heroku_username') || 'Guest';
  profileEmail.textContent = username;
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
      
      btnTriggerReset.addEventListener('click', () => {
        resetError.textContent = "Password resets are only supported in Supabase mode. For local developer testing, please reset the SQLite database.";
        resetError.classList.remove('hidden');
      });
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

        // Hook reset button
        btnTriggerReset.onclick = async () => {
          btnTriggerReset.disabled = true;
          resetSuccess.classList.add('hidden');
          resetError.classList.add('hidden');
          try {
            const { error } = await supabase.auth.resetPasswordForEmail(user.email, {
              redirectTo: `${window.location.origin}/login.html`
            });
            if (error) throw error;
            resetSuccess.textContent = `A password reset email has been sent to ${user.email}. Check your inbox.`;
            resetSuccess.classList.remove('hidden');
          } catch (e) {
            resetError.textContent = e.message;
            resetError.classList.remove('hidden');
          } finally {
            btnTriggerReset.disabled = false;
          }
        };
      } else {
        window.location.href = 'login.html';
      }
    });
  } catch (e) {
    console.error("Supabase init failed in account:", e);
  }
}

loadAccountInfo();
