import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { InputField } from '../components/common/InputField';
import { Button } from '../components/common/Button';

export const AuthPage = ({ initialMode }) => {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { login, register } = useAuth();

  const [mode, setMode] = useState(
    initialMode || (searchParams.get('mode') === 'register' ? 'signup' : 'signin')
  );

  useEffect(() => {
    if (initialMode) {
      setMode(initialMode);
    } else if (searchParams.get('mode') === 'register') {
      setMode('signup');
    }
  }, [initialMode, searchParams]);

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState([]);
  const [loading, setLoading] = useState(false);
  const [oauthNotice, setOauthNotice] = useState('');

  const validate = () => {
    if (!email.trim() || !password) {
      setError('Please fill in all required fields.');
      return false;
    }

    if (mode === 'signup') {
      const cleanUsername = username.trim().toLowerCase();
      if (!cleanUsername) {
        setError('Username is required.');
        return false;
      }
      if (cleanUsername.length < 3 || cleanUsername.length > 30) {
        setError('Username must be between 3 and 30 characters.');
        return false;
      }
      if (!/^[a-z0-9_-]+$/.test(cleanUsername)) {
        setError('Username can only contain lowercase letters, numbers, underscores, and hyphens.');
        return false;
      }
      if (password.length < 8) {
        setError('Password must be at least 8 characters long.');
        return false;
      }
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setErrorDetails([]);
    setOauthNotice('');

    if (!validate()) {
      return;
    }

    setLoading(true);
    try {
      if (mode === 'signup') {
        await register({
          email: email.trim().toLowerCase(),
          username: username.trim().toLowerCase(),
          password
        });
      } else {
        await login({
          email: email.trim().toLowerCase(),
          password
        });
      }
      const destination = location.state?.from?.pathname || '/dashboard';
      navigate(destination, { replace: true });
    } catch (err) {
      setError(err.message || 'Authentication failed. Please check your credentials.');
      if (err.details && Array.isArray(err.details) && err.details.length > 0) {
        setErrorDetails(err.details.map((d) => d.message || JSON.stringify(d)));
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGitHubOAuthClick = () => {
    setOauthNotice('GitHub OAuth will be enabled in Phase 2. Please sign up or sign in using email and password below.');
  };

  return (
    <div className="min-h-screen bg-dark-surface text-dark-on-surface font-body antialiased flex flex-col justify-between grid-lines selection:bg-accent/30 selection:text-white">
      {/* Header */}
      <header className="w-full max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded bg-dark-primary flex items-center justify-center text-white font-mono font-bold text-xs">
            GV
          </div>
          <span className="font-headline font-bold text-base text-white tracking-tight">GitView</span>
        </Link>
        <Link to="/" className="text-xs font-mono text-slate-400 hover:text-white flex items-center gap-1 transition-colors">
          <span className="material-symbols-outlined text-[16px]">arrow_back</span>
          <span>Back to overview</span>
        </Link>
      </header>

      {/* Auth Center Card */}
      <main className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-[420px] bg-dark-surface-container border border-border-strong rounded-xl p-8 shadow-2xl relative">
          {/* Brand icon and Title */}
          <div className="text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-tr from-dark-primary to-accent mx-auto flex items-center justify-center text-white font-mono font-bold text-lg mb-3 shadow-md">
              GV
            </div>
            <h1 className="font-headline text-headline-md text-white font-bold tracking-tight">
              {mode === 'signup' ? 'Create GitView Account' : 'Welcome to GitView'}
            </h1>
            <p className="text-body-sm text-slate-400 mt-1">
              {mode === 'signup'
                ? 'Get started exploring and previewing repositories'
                : 'Sign in to preview and run your private repositories'}
            </p>
          </div>

          {/* Segmented Mode Tabs: Sign In / Register */}
          <div className="grid grid-cols-2 p-1 bg-[#090D16] border border-border-subtle rounded-lg mb-6 text-xs font-label">
            <button
              type="button"
              onClick={() => {
                setMode('signin');
                setError('');
                setErrorDetails([]);
                setOauthNotice('');
              }}
              className={`py-1.5 rounded transition-all ${
                mode === 'signin'
                  ? 'text-white bg-dark-surface-container font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setError('');
                setErrorDetails([]);
                setOauthNotice('');
              }}
              className={`py-1.5 rounded transition-all ${
                mode === 'signup'
                  ? 'text-white bg-dark-surface-container font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          {/* GitHub OAuth Button (Informative notice in Phase 1) */}
          <button
            type="button"
            onClick={handleGitHubOAuthClick}
            className="w-full inline-flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-lg bg-[#1F2937] hover:bg-[#374151] border border-slate-600 text-white font-label text-label-lg transition-colors mb-2 shadow-sm active:translate-y-px"
          >
            <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            <span>{mode === 'signup' ? 'Sign up with GitHub' : 'Continue with GitHub'}</span>
          </button>

          {oauthNotice && (
            <div className="mb-4 p-2.5 bg-blue-950/40 border border-blue-500/30 rounded-lg text-xs font-mono text-blue-300 flex items-start gap-2">
              <span className="material-symbols-outlined text-[16px] shrink-0 mt-0.5">info</span>
              <span>{oauthNotice}</span>
            </div>
          )}

          {/* Divider */}
          <div className="relative flex items-center justify-center my-4">
            <div className="border-t border-border-subtle w-full"></div>
            <span className="bg-dark-surface-container px-3 text-[11px] font-mono text-slate-500 uppercase tracking-wider">
              or with email &amp; password
            </span>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {error && (
              <div className="p-3 bg-red-950/40 border border-red-500/30 rounded-lg text-xs font-mono text-red-300 space-y-1">
                <div className="flex items-center gap-2 font-semibold">
                  <span className="material-symbols-outlined text-[16px]">error</span>
                  <span>{error}</span>
                </div>
                {errorDetails.length > 0 && (
                  <ul className="list-disc list-inside text-[11px] text-red-400 pl-1 space-y-0.5">
                    {errorDetails.map((detail, idx) => (
                      <li key={idx}>{detail}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Username Field for Sign Up */}
            {mode === 'signup' && (
              <div>
                <InputField
                  label="Username"
                  placeholder="alex_rivera"
                  icon="alternate_email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, ''))}
                  required
                />
                <span className="text-[10px] font-mono text-slate-500 mt-1 block">
                  3-30 chars: lowercase letters, numbers, hyphens or underscores
                </span>
              </div>
            )}

            <InputField
              label="Work Email"
              type="email"
              placeholder="alex@company.com"
              icon="mail"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-label-md font-label text-slate-300">Password</label>
                {mode === 'signup' && (
                  <span className="text-[10px] font-mono text-slate-500">Min. 8 characters</span>
                )}
              </div>
              <InputField
                type="password"
                placeholder="••••••••"
                icon="lock"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>

            <Button
              type="submit"
              loading={loading}
              className="w-full mt-2"
              size="lg"
            >
              {mode === 'signup' ? 'Create Free Developer Account' : 'Sign In to GitView'}
            </Button>
          </form>

          {/* Security Trust Footer */}
          <div className="mt-6 pt-5 border-t border-border-subtle text-center text-xs text-slate-400">
            <p className="flex items-center justify-center gap-1 text-[11px] font-mono text-slate-500">
              <span className="material-symbols-outlined text-[14px] text-emerald-400">
                verified_user
              </span>
              <span>JWT authentication with HTTP-only cookies</span>
            </p>
          </div>
        </div>
      </main>

      {/* Mini Footer */}
      <footer className="w-full max-w-7xl mx-auto px-6 py-6 text-center text-xs font-mono text-slate-600">
        GitView • Instant Code Previews • <Link to="/" className="hover:text-slate-400">Home</Link>
      </footer>
    </div>
  );
};
