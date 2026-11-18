import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { useAuth } from '../context/AuthContext';
import { authService } from '../services/authService';
import { Toast } from '../components/common/Toast';

export const SettingsPage = () => {
  const [searchParams] = useSearchParams();
  const { user, updateUserProfile, logout } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState(user?.username || 'user');
  const email = user?.email || 'user@example.com';
  const role = user?.role || 'USER';

  // Preferences toggles
  const [autoLaunch, setAutoLaunch] = useState(true);
  const [strictNetwork, setStrictNetwork] = useState(true);
  const [hardwareAccel, setHardwareAccel] = useState(true);

  const [toast, setToast] = useState({ show: false, title: '', message: '', variant: 'success' });

  useEffect(() => {
    if (searchParams.get('github') === 'connected') {
      setToast({
        show: true,
        title: 'GitHub Connected',
        message: 'Your GitHub account has been successfully linked to GitView.',
        variant: 'success',
      });
    } else if (searchParams.get('error') === 'github_conflict') {
      setToast({
        show: true,
        title: 'Connection Conflict',
        message: 'This GitHub account is already linked to another GitView user account.',
        variant: 'danger',
      });
    }
  }, [searchParams]);

  const handleSave = (e) => {
    e.preventDefault();
    updateUserProfile({ username });
    setToast({
      show: true,
      title: 'Settings Saved',
      message: 'Your developer profile and security preferences have been updated.',
      variant: 'success',
    });
    setTimeout(() => setToast((t) => ({ ...t, show: false })), 3000);
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleConnectGitHub = () => {
    window.location.href = authService.getGitHubAuthUrl();
  };

  const userInitials = (user?.username || 'GV').slice(0, 2).toUpperCase();
  const isGitHubLinked = Boolean(user?.githubConnected);

  return (
    <AppLayout>
      {/* Toast Notification */}
      {toast.show && (
        <div className="fixed top-6 right-6 z-50">
          <Toast
            title={toast.title}
            message={toast.message}
            variant={toast.variant}
            onClose={() => setToast((t) => ({ ...t, show: false }))}
          />
        </div>
      )}

      {/* Top Header */}
      <header className="h-16 px-8 border-b border-border-subtle flex items-center justify-between bg-dark-surface shrink-0">
        <h1 className="font-headline text-headline-sm font-semibold text-white">
          Settings &amp; Preferences
        </h1>
        <div className="flex items-center gap-3">
          <button
            onClick={handleLogout}
            className="px-3.5 py-2 rounded-lg bg-red-950/40 hover:bg-red-900/50 border border-red-500/30 text-red-300 font-label text-label-md transition-colors"
          >
            Sign Out
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-label-md transition-colors shadow-sm active:translate-y-px"
          >
            Save Changes
          </button>
        </div>
      </header>

      <main className="p-8 max-w-4xl w-full mx-auto space-y-8 flex-1">
        {/* Developer Profile Card */}
        <section className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle space-y-6">
          <div>
            <h2 className="font-headline text-headline-sm font-semibold text-white">
              Developer Profile
            </h2>
            <p className="text-body-sm text-slate-400">
              Manage your public information and identity across GitView sessions
            </p>
          </div>

          <div className="flex items-center gap-5">
            <div className="relative">
              <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 flex items-center justify-center text-white font-mono text-xl font-bold border-2 border-border-strong overflow-hidden">
                {user?.avatarUrl ? (
                  <img src={user.avatarUrl} alt={username} className="w-full h-full object-cover" />
                ) : (
                  userInitials
                )}
              </div>
            </div>
            <div>
              <h3 className="font-headline text-base font-bold text-white">{username}</h3>
              <p className="text-xs font-mono text-slate-400">
                {email} • Role: {role}
              </p>
              <span className="inline-flex items-center gap-1 mt-1.5 px-2 py-0.5 rounded text-[11px] font-mono bg-blue-950/70 border border-blue-500/30 text-blue-300">
                {role} Account
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-label-md font-label text-slate-300 mb-1.5">
                Username
              </label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="w-full bg-[#080C14] border border-border-subtle text-white text-body-md px-3 py-2 rounded-lg font-mono text-xs focus:border-dark-primary focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-label-md font-label text-slate-300 mb-1.5">
                Email Address
              </label>
              <input
                type="text"
                value={email}
                disabled
                className="w-full bg-[#080C14]/50 border border-border-subtle text-slate-400 text-body-md px-3 py-2 rounded-lg font-mono text-xs cursor-not-allowed"
              />
            </div>
          </div>
        </section>

        {/* Connected GitHub Accounts Section */}
        <section className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle space-y-6">
          <div>
            <h2 className="font-headline text-headline-sm font-semibold text-white">
              Connected GitHub Accounts
            </h2>
            <p className="text-body-sm text-slate-400">
              Authorize access to explore public and connected GitHub repositories
            </p>
          </div>

          <div className="p-4 rounded-lg bg-[#080C14] border border-border-subtle flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-8 h-8 fill-current text-white" viewBox="0 0 24 24">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                />
              </svg>
              <div>
                <div className="text-sm font-bold text-white flex items-center gap-2">
                  <span>GitHub Identity</span>
                  {isGitHubLinked ? (
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950/80 text-emerald-400 border border-emerald-500/30">
                      Connected
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-800 text-slate-400 border border-border-subtle">
                      Not Linked
                    </span>
                  )}
                </div>
                <p className="text-xs font-mono text-slate-400">
                  {isGitHubLinked
                    ? 'Scopes: read:user, user:email (Tokens securely encrypted with AES-256-GCM)'
                    : 'Link your GitHub account for instant single-click sign in'}
                </p>
              </div>
            </div>

            <button
              onClick={handleConnectGitHub}
              className={`px-3 py-1.5 rounded text-xs font-mono border transition-colors ${
                isGitHubLinked
                  ? 'bg-dark-surface-container hover:bg-slate-700 text-slate-300 border-border-subtle'
                  : 'bg-dark-primary hover:bg-blue-500 text-white border-transparent'
              }`}
            >
              {isGitHubLinked ? 'Re-authenticate' : 'Connect GitHub'}
            </button>
          </div>
        </section>

        {/* Sandbox & Security Preferences */}
        <section className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle space-y-6">
          <div>
            <h2 className="font-headline text-headline-sm font-semibold text-white">
              Sandbox &amp; Security Preferences
            </h2>
            <p className="text-body-sm text-slate-400">
              Control WebContainer networking, memory caps, and terminal security
            </p>
          </div>

          <div className="space-y-4">
            {/* Toggle 1 */}
            <div className="flex items-center justify-between py-2 border-b border-border-subtle">
              <div>
                <div className="text-sm font-medium text-white">Auto-launch sandbox preview</div>
                <div className="text-xs text-slate-400">
                  Automatically boot WebContainer upon opening repository workspace.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoLaunch}
                  onChange={(e) => setAutoLaunch(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* Toggle 2 */}
            <div className="flex items-center justify-between py-2 border-b border-border-subtle">
              <div>
                <div className="text-sm font-medium text-white">Strict sandbox network isolation</div>
                <div className="text-xs text-slate-400">
                  Block external outbound HTTP requests made by previewed packages.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={strictNetwork}
                  onChange={(e) => setStrictNetwork(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {/* Toggle 3 */}
            <div className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm font-medium text-white">Hardware acceleration for WebAssembly</div>
                <div className="text-xs text-slate-400">
                  Enable SIMD and multi-threading for faster AST code indexing.
                </div>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={hardwareAccel}
                  onChange={(e) => setHardwareAccel(e.target.checked)}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>
          </div>
        </section>
      </main>
    </AppLayout>
  );
};
