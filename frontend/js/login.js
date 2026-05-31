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

const verificationView = document.getElementById('verification-view');
const profileForm = document.getElementById('profile-form');

const verificationError = document.getElementById('verification-error');
const verificationSuccess = document.getElementById('verification-success');
const profileError = document.getElementById('profile-error');

const btnCheckVerification = document.getElementById('btn-check-verification');
const btnResendVerification = document.getElementById('btn-resend-verification');

let authMode = 'supabase';
let supabase = null;

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
            if (!window.location.pathname.includes('/auth/verify.html')) {
              window.location.replace('/auth/verify.html');
            }
          } else {
            if (!window.location.pathname.includes('/auth/profile.html')) {
              window.location.replace('/auth/profile.html');
            }
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
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    
    const btnSubmit = document.getElementById('btn-login');
    btnSubmit.disabled = true;
    if (loginError) loginError.classList.add('hidden');

    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline. (To test locally without Supabase, set MINI_HEROKU_AUTH_MODE=local in your .env and restart)");
        const email = username.includes('@') ? username : `${username}@miniheroku.local`;
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          try {
            const checkRes = await fetch(`${API_BASE}/api/auth/exists?username=${encodeURIComponent(username)}`);
            if (checkRes.ok) {
              const checkData = await checkRes.json();
              if (!checkData.exists) {
                throw new Error("No account exists");
              }
            }
          } catch (checkErr) {
            if (checkErr.message === "No account exists") {
              throw checkErr;
            }
            console.error("User existence check failed:", checkErr);
          }
          throw error;
        }
        
        const user = data.user;
        const session = data.session;
        
        if (!user.email_confirmed_at) {
          window.location.replace('/auth/verify.html');
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
            window.location.replace('/index.html');
          } else if (profileRes.status === 404) {
            window.location.replace('/auth/profile.html');
          } else {
            throw new Error("Could not check profile status.");
          }
        } catch (err) {
          console.error("Profile check error:", err);
          window.location.replace('/auth/profile.html');
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
        window.location.replace('/index.html');
      }
    } catch (err) {
      if (loginError) {
        loginError.textContent = err.message;
        loginError.classList.remove('hidden');
      }
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// Sign Up Form Submission
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;
    
    const btnSubmit = document.getElementById('btn-register');
    btnSubmit.disabled = true;
    if (registerError) registerError.classList.add('hidden');
    if (registerSuccess) registerSuccess.classList.add('hidden');

    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline. (To test locally without Supabase, set MINI_HEROKU_AUTH_MODE=local in your .env and restart)");
        const email = username.includes('@') ? username : `${username}@miniheroku.local`;
        const { data, error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        
        // Save register email temporarily in cache for potential resends
        localStorage.setItem('vessel_temp_register_email', email);
        window.location.replace('/auth/verify.html');
      } else {
        const res = await fetch(`${API_BASE}/api/auth/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || 'Registration failed.');

        if (registerSuccess) {
          registerSuccess.textContent = "Account created. Switching to Sign In...";
          registerSuccess.classList.remove('hidden');
        }
        registerForm.reset();
        setTimeout(() => {
          window.location.replace('/auth/login.html');
        }, 1500);
      }
    } catch (err) {
      if (registerError) {
        registerError.textContent = err.message;
        registerError.classList.remove('hidden');
      }
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// Forgot Password Form Submission
if (forgotForm) {
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('forgot-email').value.trim();
    
    const btnSubmit = document.getElementById('btn-forgot');
    btnSubmit.disabled = true;
    if (forgotError) forgotError.classList.add('hidden');
    if (forgotSuccess) forgotSuccess.classList.add('hidden');

    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline.");
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/login.html`
        });
        if (error) throw error;
        if (forgotSuccess) forgotSuccess.classList.remove('hidden');
        forgotForm.reset();
      } else {
        throw new Error("Password resetting is only supported in Supabase mode. For developer local auth testing, recreate the database schema.");
      }
    } catch (err) {
      if (forgotError) {
        forgotError.textContent = err.message;
        forgotError.classList.remove('hidden');
      }
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// Verification Check & Resend Event Listeners
if (btnCheckVerification) {
  btnCheckVerification.addEventListener('click', async () => {
    if (!supabase) {
      if (verificationError) {
        verificationError.textContent = "Supabase Client is offline. Please reload or sign in again.";
        verificationError.classList.remove('hidden');
      }
      return;
    }
    
    btnCheckVerification.disabled = true;
    if (verificationError) verificationError.classList.add('hidden');
    if (verificationSuccess) verificationSuccess.classList.add('hidden');
    
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
            window.location.replace('/index.html');
          } else if (profileRes.status === 404) {
            window.location.replace('/auth/profile.html');
          } else {
            throw new Error("Failed to verify user profile state.");
          }
        } else {
          if (verificationError) {
            verificationError.textContent = "Email is not verified yet. Please click the verification link in your email and try again.";
            verificationError.classList.remove('hidden');
          }
        }
      } else {
        if (verificationError) {
          verificationError.textContent = "Session not found. If you have already clicked the link, please sign in.";
          verificationError.classList.remove('hidden');
        }
      }
    } catch (err) {
      if (verificationError) {
        verificationError.textContent = err.message;
        verificationError.classList.remove('hidden');
      }
    } finally {
      btnCheckVerification.disabled = false;
    }
  });
}

if (btnResendVerification) {
  btnResendVerification.addEventListener('click', async () => {
    if (!supabase) return;
    
    // Retrieve email from temporary storage since register form is on a different page
    const email = localStorage.getItem('vessel_temp_register_email') || '';
    if (!email) {
      if (verificationError) {
        verificationError.textContent = "Email address not found in session cache. Please register again.";
        verificationError.classList.remove('hidden');
      }
      return;
    }

    btnResendVerification.disabled = true;
    if (verificationError) verificationError.classList.add('hidden');
    if (verificationSuccess) verificationSuccess.classList.add('hidden');
    
    try {
      const formattedEmail = email.includes('@') ? email : `${email}@miniheroku.local`;
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: formattedEmail
      });
      if (error) throw error;
      if (verificationSuccess) {
        verificationSuccess.textContent = "A new verification link has been sent to " + formattedEmail;
        verificationSuccess.classList.remove('hidden');
      }
    } catch (err) {
      if (verificationError) {
        verificationError.textContent = err.message;
        verificationError.classList.remove('hidden');
      }
    } finally {
      btnResendVerification.disabled = false;
    }
  });
}

// Profile Details Form Submission
if (profileForm) {
  profileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('profile-name').value.trim();
    const use_case = document.getElementById('profile-use-case').value.trim();
    const company = document.getElementById('profile-company').value.trim();
    
    const btnSubmit = document.getElementById('btn-save-profile');
    btnSubmit.disabled = true;
    if (profileError) profileError.classList.add('hidden');
    
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
      window.location.replace('/index.html');
    } catch (err) {
      if (profileError) {
        profileError.textContent = err.message;
        profileError.classList.remove('hidden');
      }
    } finally {
      btnSubmit.disabled = false;
    }
  });
}

// Initialize Config load
loadAuthConfig();
