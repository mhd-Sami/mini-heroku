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

// Input validation functions
function validateUsernameOrEmail(val) {
  if (val.includes('@')) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (emailRegex.test(val)) {
      return { isValid: true, message: 'Valid email format.' };
    } else {
      return { isValid: false, message: 'Please enter a valid email address.' };
    }
  } else {
    const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
    if (usernameRegex.test(val)) {
      return { isValid: true, message: 'Valid username format.' };
    } else {
      return { isValid: false, message: 'Username must be 3-20 characters (letters, numbers, _, -).' };
    }
  }
}

function validateEmailOnly(val) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (emailRegex.test(val)) {
    return { isValid: true, message: 'Valid email format.' };
  } else {
    return { isValid: false, message: 'Please enter a valid email address.' };
  }
}

function validatePassword(val) {
  if (val.length >= 6) {
    return { isValid: true, message: 'Password length is sufficient.' };
  } else {
    return { isValid: false, message: 'Password must be at least 6 characters long.' };
  }
}

function setupRealtimeValidation(inputId, validationFn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  // Create validation message container
  let msg = document.getElementById(`${inputId}-val-msg`);
  if (!msg) {
    msg = document.createElement('div');
    msg.id = `${inputId}-val-msg`;
    msg.className = 'input-hint val-msg hidden';
    msg.style.marginTop = '0.25rem';
    msg.style.fontSize = '0.8rem';
    msg.style.fontWeight = '500';
    msg.style.transition = 'all 0.2s ease';
    input.parentNode.appendChild(msg);
  }

  input.addEventListener('input', () => {
    const value = input.value;
    if (value === '') {
      msg.classList.add('hidden');
      input.style.borderColor = '';
      return;
    }

    const { isValid, message } = validationFn(value);
    msg.textContent = message;
    msg.classList.remove('hidden');

    if (isValid) {
      msg.style.color = '#22c55e'; // Success Green
      input.style.borderColor = '#22c55e';
    } else {
      msg.style.color = '#ef4444'; // Danger Red
      input.style.borderColor = '#ef4444';
    }
  });
}

let usernameCheckTimeout = null;
function setupRealtimeUsernameUniqueness(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  let msg = document.getElementById(`${inputId}-val-msg`);
  if (!msg) {
    msg = document.createElement('div');
    msg.id = `${inputId}-val-msg`;
    msg.className = 'input-hint val-msg hidden';
    msg.style.marginTop = '0.25rem';
    msg.style.fontSize = '0.8rem';
    msg.style.fontWeight = '500';
    msg.style.transition = 'all 0.2s ease';
    input.parentNode.appendChild(msg);
  }

  input.addEventListener('input', () => {
    const val = input.value.trim();
    if (usernameCheckTimeout) {
      clearTimeout(usernameCheckTimeout);
    }

    if (val === '') {
      msg.classList.add('hidden');
      input.style.borderColor = '';
      return;
    }

    const usernameRegex = /^[a-zA-Z0-9_-]{3,20}$/;
    if (!usernameRegex.test(val)) {
      msg.textContent = 'Username must be 3-20 characters (letters, numbers, _, -).';
      msg.classList.remove('hidden');
      msg.style.color = '#ef4444';
      input.style.borderColor = '#ef4444';
      return;
    }

    msg.textContent = 'Checking availability...';
    msg.classList.remove('hidden');
    msg.style.color = '#a0aec0';
    input.style.borderColor = '#a0aec0';

    usernameCheckTimeout = setTimeout(async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/exists?username=${encodeURIComponent(val)}`);
        if (!res.ok) throw new Error('Uniqueness check failed');
        const data = await res.json();
        if (input.value.trim() !== val) return;

        if (data.exists) {
          msg.textContent = 'Username already taken.';
          msg.style.color = '#ef4444';
          input.style.borderColor = '#ef4444';
        } else {
          msg.textContent = 'Username is available!';
          msg.style.color = '#22c55e';
          input.style.borderColor = '#22c55e';
        }
      } catch (err) {
        console.error(err);
        if (input.value.trim() !== val) return;
        msg.textContent = 'Error checking username availability.';
        msg.style.color = '#a0aec0';
        input.style.borderColor = '';
      }
    }, 400);
  });
}

// Setup real-time validation on available inputs
setupRealtimeValidation('login-username', validateUsernameOrEmail);
setupRealtimeValidation('login-password', validatePassword);
setupRealtimeValidation('register-username', validateUsernameOrEmail);
setupRealtimeValidation('register-password', validatePassword);
setupRealtimeValidation('forgot-email', validateEmailOnly);
setupRealtimeUsernameUniqueness('profile-username');

// Load configurations on startup
async function loadAuthConfig() {
  try {
    const res = await fetch(`${API_BASE}/api/auth/config`);
    if (!res.ok) throw new Error('Failed to fetch auth configuration');
    const config = await res.json();
    authMode = config.auth_mode;

    if (authMode === 'supabase') {
      await initializeSupabase(config.supabase_config);
      if (!supabase) return;

      // Listen for auth state changes (captures callbacks, sign ins, verify links)
      supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'PASSWORD_RECOVERY') {
          window.location.replace('/auth/reset-password.html');
          return;
        }
        if (session && session.user) {
          const token = session.access_token;
          localStorage.setItem('mini_heroku_token', token);
          
          // Set email as temporary fallback username if none exists or is an email
          const currentStoredUsername = localStorage.getItem('mini_heroku_username');
          if (!currentStoredUsername || currentStoredUsername.includes('@')) {
            localStorage.setItem('mini_heroku_username', session.user.email);
          }

          if (session.user.email_confirmed_at) {
            try {
              const profileRes = await fetch(`${API_BASE}/api/auth/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (profileRes.ok) {
                const profileData = await profileRes.json();
                if (profileData.username) {
                  localStorage.setItem('mini_heroku_username', profileData.username);
                }
                localStorage.setItem('mini_heroku_profile_completed', 'true');
                if (window.location.pathname.includes('/auth/') && !window.location.pathname.includes('reset-password.html')) {
                  window.location.replace('/index.html');
                }
              } else if (profileRes.status === 404) {
                localStorage.removeItem('mini_heroku_profile_completed');
                if (!window.location.pathname.includes('/auth/profile.html')) {
                  window.location.replace('/auth/profile.html');
                }
              }
            } catch (err) {
              console.error("Error checking profile on auth change:", err);
              if (!window.location.pathname.includes('/auth/profile.html')) {
                window.location.replace('/auth/profile.html');
              }
            }
          } else {
            if (!window.location.pathname.includes('/auth/verify.html')) {
              window.location.replace('/auth/verify.html');
            }
          }
        } else if (event === 'SIGNED_OUT') {
          localStorage.removeItem('mini_heroku_token');
          localStorage.removeItem('mini_heroku_username');
          localStorage.removeItem('mini_heroku_profile_completed');
        }
      });

      // Explicitly check current session state (e.g. on direct page loads/refresh)
      const { data: { session } } = await supabase.auth.getSession();
      if (session && session.user) {
        const token = session.access_token;
        localStorage.setItem('mini_heroku_token', token);
        
        // Set email as temporary fallback username if none exists or is an email
        const currentStoredUsername = localStorage.getItem('mini_heroku_username');
        if (!currentStoredUsername || currentStoredUsername.includes('@')) {
          localStorage.setItem('mini_heroku_username', session.user.email);
        }

        if (session.user.email_confirmed_at) {
          const profileCompleted = localStorage.getItem('mini_heroku_profile_completed');
          // If profile completed is not set or username is still email, let's fetch profile to sync username
          if (!profileCompleted || !currentStoredUsername || currentStoredUsername.includes('@')) {
            try {
              const profileRes = await fetch(`${API_BASE}/api/auth/profile`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              if (profileRes.ok) {
                const profileData = await profileRes.json();
                if (profileData.username) {
                  localStorage.setItem('mini_heroku_username', profileData.username);
                }
                localStorage.setItem('mini_heroku_profile_completed', 'true');
                if (window.location.pathname.includes('/auth/') && !window.location.pathname.includes('reset-password.html')) {
                  window.location.replace('/index.html');
                }
              } else if (profileRes.status === 404) {
                if (!window.location.pathname.includes('/auth/profile.html')) {
                  window.location.replace('/auth/profile.html');
                }
              }
            } catch (err) {
              console.error("Error checking profile on initial session check:", err);
              if (!window.location.pathname.includes('/auth/profile.html')) {
                window.location.replace('/auth/profile.html');
              }
            }
          }
        } else {
          if (!window.location.pathname.includes('/auth/verify.html')) {
            window.location.replace('/auth/verify.html');
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

    // Real-time block check on submit
    const usernameVal = validateUsernameOrEmail(username);
    const passwordVal = validatePassword(password);
    if (!usernameVal.isValid || !passwordVal.isValid) {
      if (loginError) {
        loginError.textContent = !usernameVal.isValid ? usernameVal.message : passwordVal.message;
        loginError.classList.remove('hidden');
      }
      btnSubmit.disabled = false;
      return;
    }

    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline. (To test locally without Supabase, set MINI_HEROKU_AUTH_MODE=local in your .env and restart)");
        
        let email = username;
        if (!username.includes('@')) {
          try {
            const resolveRes = await fetch(`${API_BASE}/api/auth/resolve?username=${encodeURIComponent(username)}`);
            if (!resolveRes.ok) {
              const resolveData = await resolveRes.json();
              throw new Error(resolveData.detail || "No account exists with this username.");
            }
            const resolveData = await resolveRes.json();
            email = resolveData.email;
          } catch (resolveErr) {
            throw new Error(resolveErr.message || "Failed to resolve username.");
          }
        }

        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
          try {
            const checkRes = await fetch(`${API_BASE}/api/auth/exists?username=${encodeURIComponent(email)}`);
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
            const profileData = await profileRes.json();
            if (profileData.username) {
              localStorage.setItem('mini_heroku_username', profileData.username);
            }
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

    // Real-time block check on submit
    const usernameVal = validateUsernameOrEmail(username);
    const passwordVal = validatePassword(password);
    if (!usernameVal.isValid || !passwordVal.isValid) {
      if (registerError) {
        registerError.textContent = !usernameVal.isValid ? usernameVal.message : passwordVal.message;
        registerError.classList.remove('hidden');
      }
      btnSubmit.disabled = false;
      return;
    }

    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline. (To test locally without Supabase, set MINI_HEROKU_AUTH_MODE=local in your .env and restart)");
        const email = username.includes('@') ? username : `${username}@miniheroku.local`;
        const { data, error } = await supabase.auth.signUp({ 
          email, 
          password,
          options: {
            emailRedirectTo: window.location.origin + '/auth/login.html'
          }
        });
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

    // Real-time block check on submit
    const emailVal = validateEmailOnly(email);
    if (!emailVal.isValid) {
      if (forgotError) {
        forgotError.textContent = emailVal.message;
        forgotError.classList.remove('hidden');
      }
      btnSubmit.disabled = false;
      return;
    }

    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline.");
        
        // Verify account exists before triggering password reset email
        const checkRes = await fetch(`${API_BASE}/api/auth/exists?username=${encodeURIComponent(email)}`);
        if (checkRes.ok) {
          const checkData = await checkRes.json();
          if (!checkData.exists) {
            throw new Error("No account exists with this email address.");
          }
        } else {
          throw new Error("Failed to verify account status. Please try again.");
        }

        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/auth/reset-password.html`
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
      // Fetch latest user details from Supabase server to check verification status
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError) throw userError;

      if (user) {
        if (user.email_confirmed_at) {
          // Force token refresh to include the email confirmation claim
          const { data: { session }, error: refreshError } = await supabase.auth.refreshSession();
          if (refreshError) throw refreshError;

          if (session) {
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
            throw new Error("Could not refresh active session.");
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
    const username = document.getElementById('profile-username').value.trim();
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
        body: JSON.stringify({ name, username, use_case, company: company || null })
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Failed to submit profile details.");
      
      localStorage.setItem('mini_heroku_username', username);
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

// Reset Password Form Submission
const resetPasswordForm = document.getElementById('reset-password-form');
const resetPasswordError = document.getElementById('reset-password-error');
const resetPasswordSuccess = document.getElementById('reset-password-success');

if (resetPasswordForm) {
  setupRealtimeValidation('reset-new-password', validatePassword);
  setupRealtimeValidation('reset-confirm-password', (val) => {
    const p1 = document.getElementById('reset-new-password').value;
    if (val === p1) {
      return { isValid: true, message: 'Passwords match.' };
    } else {
      return { isValid: false, message: 'Passwords do not match.' };
    }
  });

  resetPasswordForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newPassword = document.getElementById('reset-new-password').value;
    const confirmPassword = document.getElementById('reset-confirm-password').value;
    
    const btnSubmit = document.getElementById('btn-submit-reset-password');
    btnSubmit.disabled = true;
    const originalText = btnSubmit.textContent;
    btnSubmit.innerHTML = `<span class="btn-spinner"></span> Updating...`;
    
    if (resetPasswordError) resetPasswordError.classList.add('hidden');
    if (resetPasswordSuccess) resetPasswordSuccess.classList.add('hidden');
    
    const pVal = validatePassword(newPassword);
    if (!pVal.isValid) {
      resetPasswordError.textContent = pVal.message;
      resetPasswordError.classList.remove('hidden');
      btnSubmit.disabled = false;
      btnSubmit.textContent = originalText;
      return;
    }
    
    if (newPassword !== confirmPassword) {
      resetPasswordError.textContent = "Passwords do not match.";
      resetPasswordError.classList.remove('hidden');
      btnSubmit.disabled = false;
      btnSubmit.textContent = originalText;
      return;
    }
    
    try {
      if (authMode === 'supabase') {
        if (!supabase) throw new Error("Supabase Client is offline.");
        const { error } = await supabase.auth.updateUser({ password: newPassword });
        if (error) throw error;
        
        resetPasswordSuccess.textContent = "Password updated successfully! Redirecting to login...";
        resetPasswordSuccess.classList.remove('hidden');
        resetPasswordForm.reset();
        
        // Log out user so they have to sign in again with the new password
        await supabase.auth.signOut();
        localStorage.removeItem('mini_heroku_token');
        localStorage.removeItem('mini_heroku_username');
        localStorage.removeItem('mini_heroku_profile_completed');
        
        setTimeout(() => {
          window.location.replace('/auth/login.html');
        }, 3000);
      } else {
        throw new Error("Password resetting is only supported in Supabase mode.");
      }
    } catch (err) {
      resetPasswordError.textContent = err.message;
      resetPasswordError.classList.remove('hidden');
      btnSubmit.disabled = false;
      btnSubmit.textContent = originalText;
    }
  });
}

// Initialize Config load
loadAuthConfig();
