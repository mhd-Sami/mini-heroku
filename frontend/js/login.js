import { createClient } from '@supabase/supabase-js';

const API_BASE = window.location.origin;

// DOM Elements
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const forgotForm = document.getElementById('forgot-form');

const loginError = document.getElementById('login-error');
const registerError = document.getElementById('register-error');
const registerSuccess = document.getElementById('register-success');
const forgotError = document.getElementById('forgot-error');
const forgotSuccess = document.getElementById('forgot-success');

const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
const tabForgot = document.getElementById('tab-forgot');

const verificationView = document.getElementById('verification-view');
const profileForm = document.getElementById('profile-form');

const verificationError = document.getElementById('verification-error');
const verificationSuccess = document.getElementById('verification-success');
const profileError = document.getElementById('profile-error');

const btnCheckVerification = document.getElementById('btn-check-verification');
const btnResendVerification = document.getElementById('btn-resend-verification');

let authMode = 'supabase';
let supabase = null;

// Tab Switchers
tabLogin.addEventListener('click', () => {
  setActiveTab(tabLogin, loginForm);
});

tabRegister.addEventListener('click', () => {
  setActiveTab(tabRegister, registerForm);
});

tabForgot.addEventListener('click', () => {
  setActiveTab(tabForgot, forgotForm);
});

function setActiveView(activeElement) {
  [loginForm, registerForm, forgotForm, verificationView, profileForm].forEach(el => {
    if (el) el.classList.add('hidden');
  });
  [loginError, registerError, registerSuccess, forgotError, forgotSuccess, verificationError, verificationSuccess, profileError].forEach(el => {
    if (el) el.classList.add('hidden');
  });
  activeElement.classList.remove('hidden');
}

function setActiveTab(activeTabBtn, activeForm) {
  document.querySelector('.auth-tabs').classList.remove('hidden');
  [tabLogin, tabRegister, tabForgot].forEach(btn => btn.classList.remove('active'));
  setActiveView(activeForm);
  activeTabBtn.classList.add('active');
}

// Load configurations on startup
async function loadAuthConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/config`);
    if (!res.ok) throw new Error('Failed to fetch auth configuration');
    const config = await res.json();
    authMode = config.auth_mode;

    if (authMode === 'supabase') {
      await initializeSupabase(config.supabase_config);
      
      const token = localStorage.getItem('mini_heroku_token');
      const profileCompleted = localStorage.getItem('mini_heroku_profile_completed');
      if (token && !profileCompleted && supabase) {
        const { data: { user } } = await supabase.auth.getUser();
        if (user) {
          if (!user.email_confirmed_at) {
            document.querySelector('.auth-tabs').classList.add('hidden');
            setActiveView(verificationView);
          } else {
            document.querySelector('.auth-tabs').classList.add('hidden');
            setActiveView(profileForm);
          }
        }
      }
    } else {
      console.log("Local developer override authentication enabled.");
    }
  } catch (err) {
    console.error('Error loading config:', err);
    authMode = 'local'; // local fallback
  }
}

async function initializeSupabase(supabaseConfig) {
  if (!supabaseConfig) {
    console.error("Supabase public credentials are not configured on the backend environment.");
    return;
  }
  try {
    supabase = createClient(supabaseConfig.supabaseUrl, supabaseConfig.supabaseAnonKey);

    // If redirected with ?action=logout, sign out immediately
    const params = new URLSearchParams(window.location.search);
    if (params.get('action') === 'logout') {
      await supabase.auth.signOut();
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  } catch (e) {
    console.error("Supabase client initialization failed:", e);
  }
}

// Sign In Form Submission
loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  
  const btnSubmit = document.getElementById('btn-login');
  btnSubmit.disabled = true;
  loginError.classList.add('hidden');

  try {
    if (authMode === 'supabase') {
      if (!supabase) throw new Error("Supabase Client is offline. (To test locally without Supabase, set MINI_HEROKU_AUTH_MODE=local in your .env and restart)");
      const email = username.includes('@') ? username : `${username}@miniheroku.local`;
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      
      const user = data.user;
      const session = data.session;
      
      if (!user.email_confirmed_at) {
        document.querySelector('.auth-tabs').classList.add('hidden');
        setActiveView(verificationView);
        return;
      }
      
      const token = session.access_token;
      localStorage.setItem('mini_heroku_token', token);
      localStorage.setItem('mini_heroku_username', user.email);
      
      try {
        const profileRes = await fetch(`${API_BASE}/api/auth/profile`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (profileRes.ok) {
          localStorage.setItem('mini_heroku_profile_completed', 'true');
          window.location.href = 'index.html';
        } else if (profileRes.status === 404) {
          document.querySelector('.auth-tabs').classList.add('hidden');
          setActiveView(profileForm);
        } else {
          throw new Error("Could not check profile status.");
        }
      } catch (err) {
        console.error("Profile check error:", err);
        document.querySelector('.auth-tabs').classList.add('hidden');
        setActiveView(profileForm);
      }
    } else {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Access Denied.');

      localStorage.setItem('mini_heroku_token', data.access_token);
      localStorage.setItem('mini_heroku_username', data.username);
      localStorage.setItem('mini_heroku_profile_completed', 'true');
      window.location.href = 'index.html';
    }
  } catch (err) {
    loginError.textContent = err.message;
    loginError.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
  }
});

// Sign Up Form Submission
registerForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value;
  
  const btnSubmit = document.getElementById('btn-register');
  btnSubmit.disabled = true;
  registerError.classList.add('hidden');
  registerSuccess.classList.add('hidden');

  try {
    if (authMode === 'supabase') {
      if (!supabase) throw new Error("Supabase Client is offline. (To test locally without Supabase, set MINI_HEROKU_AUTH_MODE=local in your .env and restart)");
      const email = username.includes('@') ? username : `${username}@miniheroku.local`;
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      
      // Hide tabs to lock user in verification flow
      document.querySelector('.auth-tabs').classList.add('hidden');
      setActiveView(verificationView);
    } else {
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || 'Registration failed.');

      registerSuccess.textContent = "Account created. Switching to Sign In...";
      registerSuccess.classList.remove('hidden');
      registerForm.reset();
      setTimeout(() => {
        tabLogin.click();
      }, 1500);
    }
  } catch (err) {
    registerError.textContent = err.message;
    registerError.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
  }
});

// Forgot Password Form Submission
forgotForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('forgot-email').value.trim();
  
  const btnSubmit = document.getElementById('btn-forgot');
  btnSubmit.disabled = true;
  forgotError.classList.add('hidden');
  forgotSuccess.classList.add('hidden');

  try {
    if (authMode === 'supabase') {
      if (!supabase) throw new Error("Supabase Client is offline.");
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/login.html`
      });
      if (error) throw error;
      forgotSuccess.classList.remove('hidden');
      forgotForm.reset();
    } else {
      throw new Error("Password resetting is only supported in Supabase mode. For developer local auth testing, recreate the database schema.");
    }
  } catch (err) {
    forgotError.textContent = err.message;
    forgotError.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
  }
});

// Verification Check & Resend Event Listeners
btnCheckVerification.addEventListener('click', async () => {
  if (!supabase) {
    verificationError.textContent = "Supabase Client is offline. Please reload or sign in again.";
    verificationError.classList.remove('hidden');
    return;
  }
  
  btnCheckVerification.disabled = true;
  verificationError.classList.add('hidden');
  verificationSuccess.classList.add('hidden');
  
  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;

    if (session && session.user) {
      const user = session.user;
      
      if (user.email_confirmed_at) {
        const token = session.access_token;
        localStorage.setItem('mini_heroku_token', token);
        localStorage.setItem('mini_heroku_username', user.email);
        
        const profileRes = await fetch(`${API_BASE}/api/auth/profile`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (profileRes.ok) {
          localStorage.setItem('mini_heroku_profile_completed', 'true');
          window.location.href = 'index.html';
        } else if (profileRes.status === 404) {
          setActiveView(profileForm);
        } else {
          throw new Error("Failed to verify user profile state.");
        }
      } else {
        verificationError.textContent = "Email is not verified yet. Please click the verification link in your email and try again.";
        verificationError.classList.remove('hidden');
      }
    } else {
      verificationError.textContent = "Session not found. If you have already clicked the link, please return to the Sign In tab and sign in.";
      verificationError.classList.remove('hidden');
    }
  } catch (err) {
    verificationError.textContent = err.message;
    verificationError.classList.remove('hidden');
  } finally {
    btnCheckVerification.disabled = false;
  }
});

btnResendVerification.addEventListener('click', async () => {
  if (!supabase) return;
  
  const email = document.getElementById('register-username').value.trim();
  if (!email) {
    verificationError.textContent = "Email address not found. Please reload and register again.";
    verificationError.classList.remove('hidden');
    return;
  }

  btnResendVerification.disabled = true;
  verificationError.classList.add('hidden');
  verificationSuccess.classList.add('hidden');
  
  try {
    const formattedEmail = email.includes('@') ? email : `${email}@miniheroku.local`;
    const { error } = await supabase.auth.resend({
      type: 'signup',
      email: formattedEmail
    });
    if (error) throw error;
    verificationSuccess.textContent = "A new verification link has been sent to " + formattedEmail;
    verificationSuccess.classList.remove('hidden');
  } catch (err) {
    verificationError.textContent = err.message;
    verificationError.classList.remove('hidden');
  } finally {
    btnResendVerification.disabled = false;
  }
});

// Profile Details Form Submission
profileForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('profile-name').value.trim();
  const use_case = document.getElementById('profile-use-case').value.trim();
  const company = document.getElementById('profile-company').value.trim();
  
  const btnSubmit = document.getElementById('btn-save-profile');
  btnSubmit.disabled = true;
  profileError.classList.add('hidden');
  
  try {
    const token = localStorage.getItem('mini_heroku_token');
    if (!token) throw new Error("Missing authentication token. Please sign in again.");
    
    const res = await fetch(`${API_BASE}/api/auth/profile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ name, use_case, company: company || null })
    });
    
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to submit profile details.");
    
    localStorage.setItem('mini_heroku_profile_completed', 'true');
    window.location.href = 'index.html';
  } catch (err) {
    profileError.textContent = err.message;
    profileError.classList.remove('hidden');
  } finally {
    btnSubmit.disabled = false;
  }
});

// Initialize Config load
loadAuthConfig();
