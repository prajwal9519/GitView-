import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { repoService } from '../services/repoService';
import { githubService } from '../services/githubService';
import { authService } from '../services/authService';
import { useAuth } from '../context/AuthContext';
import { Toast } from '../components/common/Toast';

export const ImportRepoPage = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  // Manual import form states
  const [repoUrl, setRepoUrl] = useState('https://github.com/shadcn-ui/ui');
  const [branch, setBranch] = useState('main');
  const [preset, setPreset] = useState('auto');
  const [simulatedState, setSimulatedState] = useState('valid'); // 'valid' | 'invalid' | 'unsupported'
  const [analyzing, setAnalyzing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // GitHub live repos states
  const [githubRepos, setGithubRepos] = useState([]);
  const [page, setPage] = useState(1);
  const [loadingGithub, setLoadingGithub] = useState(false);
  const [githubError, setGithubError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [importingRepoName, setImportingRepoName] = useState(null);

  // Notification toast
  const [toast, setToast] = useState({ show: false, title: '', message: '', variant: 'success' });

  // Fetch GitHub repos if account is connected
  const fetchGitHubRepos = useCallback(async (targetPage = 1) => {
    if (!user?.githubConnected) return;

    setLoadingGithub(true);
    setGithubError(null);
    try {
      const res = await githubService.getUserRepositories(targetPage, 10);
      setGithubRepos(res.data || []);
      setPage(targetPage);
    } catch (err) {
      setGithubError(err.message || 'Failed to load GitHub repositories.');
    } finally {
      setLoadingGithub(false);
    }
  }, [user?.githubConnected]);

  useEffect(() => {
    if (user?.githubConnected) {
      fetchGitHubRepos(1);
    }
  }, [user?.githubConnected, fetchGitHubRepos]);

  const handleInputChange = async (value) => {
    setRepoUrl(value);
    setAnalyzing(true);
    try {
      const result = await repoService.preflightAnalyze(value);
      setSimulatedState(result.status);
    } catch {
      setSimulatedState('invalid');
    } finally {
      setAnalyzing(false);
    }
  };

  const setManualState = (state) => {
    setSimulatedState(state);
    if (state === 'invalid') {
      setRepoUrl('https://github.com/non-existent-user/ghost-repo-xyz');
    } else if (state === 'unsupported') {
      setRepoUrl('https://github.com/torvalds/linux');
    } else {
      setRepoUrl('https://github.com/shadcn-ui/ui');
    }
  };

  // Direct real import via button
  const handleImport = async (e) => {
    e?.preventDefault();
    if (!repoUrl.trim()) return;

    setIsImporting(true);
    try {
      const imported = await repoService.importRepository(repoUrl.trim());
      setToast({
        show: true,
        title: 'Repository Imported',
        message: `Successfully imported ${imported.fullName} to your GitView workspace.`,
        variant: 'success',
      });
      // Refresh live GitHub repositories imported flags
      if (user?.githubConnected) {
        fetchGitHubRepos(page);
      }
      setTimeout(() => {
        navigate('/dashboard');
      }, 1200);
    } catch (err) {
      setToast({
        show: true,
        title: 'Import Failed',
        message: err.message || 'Could not import repository.',
        variant: 'error',
      });
    } finally {
      setIsImporting(false);
    }
  };

  // One-click import from live GitHub list
  const handleImportGitHubRepo = async (fullName) => {
    setImportingRepoName(fullName);
    try {
      const imported = await repoService.importRepository(fullName);
      setToast({
        show: true,
        title: 'Repository Imported',
        message: `Successfully imported ${imported.fullName}.`,
        variant: 'success',
      });
      // Mark as imported locally
      setGithubRepos((prev) =>
        prev.map((r) =>
          r.fullName === fullName ? { ...r, isImported: true, importedRepoId: imported.id } : r
        )
      );
    } catch (err) {
      setToast({
        show: true,
        title: 'Import Failed',
        message: err.message || `Failed to import ${fullName}.`,
        variant: 'error',
      });
    } finally {
      setImportingRepoName(null);
    }
  };

  const handleLaunch = (e) => {
    e.preventDefault();
    if (simulatedState === 'invalid') {
      alert('Cannot launch an invalid or unreachable repository.');
      return;
    }
    navigate(`/workspace?repo=${encodeURIComponent(repoUrl)}&branch=${branch}`);
  };

  // Filter GitHub repositories by search
  const filteredGitHubRepos = githubRepos.filter((repo) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      repo.fullName?.toLowerCase().includes(q) ||
      repo.description?.toLowerCase().includes(q) ||
      repo.primaryLanguage?.toLowerCase().includes(q)
    );
  });

  return (
    <AppLayout>
      {/* Top Header */}
      <header className="h-16 px-8 border-b border-border-subtle flex items-center justify-between bg-dark-surface shrink-0">
        <div className="flex items-center gap-3">
          <Link to="/dashboard" className="text-slate-400 hover:text-white flex items-center transition-colors">
            <span className="material-symbols-outlined text-[20px]">arrow_back</span>
          </Link>
          <h1 className="font-headline text-headline-sm font-semibold text-white">
            Import Repository
          </h1>
          <span className="text-xs font-mono text-slate-500">• Clone &amp; Sandbox Setup</span>
        </div>

        <div className="flex items-center gap-3 text-xs font-mono">
          {user?.githubConnected ? (
            <span className="text-slate-400 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
              <span>Connected: <strong className="text-white">{user?.username}</strong></span>
            </span>
          ) : (
            <button
              onClick={() => { window.location.href = authService.getGitHubAuthUrl(); }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#090D16] hover:bg-slate-800 border border-border-subtle text-slate-300 transition-colors"
            >
              <svg className="w-3.5 h-3.5 fill-current" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span>Connect GitHub</span>
            </button>
          )}
        </div>
      </header>

      {/* Floating Toast Notification */}
      {toast.show && (
        <div className="fixed top-20 right-8 z-50 max-w-md w-full animate-in fade-in slide-in-from-top-4">
          <Toast
            title={toast.title}
            message={toast.message}
            variant={toast.variant}
            onClose={() => setToast((prev) => ({ ...prev, show: false }))}
          />
        </div>
      )}

      <main className="p-8 max-w-5xl w-full mx-auto space-y-8 flex-1">
        {/* Primary Import Wizard Container */}
        <div className="bg-dark-surface-container border border-border-strong rounded-xl p-6 sm:p-8 shadow-xl">
          <div className="mb-6">
            <h2 className="font-headline text-headline-md font-bold text-white">
              Target Repository Specification
            </h2>
            <p className="text-body-sm text-slate-400 mt-1">
              Import any public GitHub repository to explore its AST, inspect dependencies, or initialize an in-browser sandbox.
            </p>
          </div>

          <form onSubmit={handleLaunch} className="space-y-6">
            {/* Repository URL Input */}
            <div>
              <label className="block text-label-md font-label text-slate-300 mb-2">
                GitHub Repository URL or Identifier <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-3 text-slate-400 text-[18px]">
                  link
                </span>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => handleInputChange(e.target.value)}
                  placeholder="e.g. facebook/react or https://github.com/facebook/react"
                  className={`w-full bg-[#080C14] border text-white font-mono text-sm pl-11 pr-24 py-2.5 rounded-lg transition-colors focus:outline-none ${
                    simulatedState === 'invalid'
                      ? 'border-red-500 focus:border-red-500 focus:ring-1 focus:ring-red-500'
                      : simulatedState === 'unsupported'
                      ? 'border-amber-500 focus:border-amber-500 focus:ring-1 focus:ring-amber-500'
                      : 'border-border-strong focus:border-dark-primary focus:ring-1 focus:ring-dark-primary'
                  }`}
                />
                <div className="absolute right-3 top-2.5 flex items-center gap-1.5">
                  {analyzing ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-blue-950/80 text-blue-400 border border-blue-500/30 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                      <span>Analyzing...</span>
                    </span>
                  ) : simulatedState === 'invalid' ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-red-950/80 text-red-400 border border-red-500/30 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400"></span>
                      <span>404 Not Found</span>
                    </span>
                  ) : simulatedState === 'unsupported' ? (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-amber-950/80 text-amber-400 border border-amber-500/30 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-400"></span>
                      <span>Code Only</span>
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-950/80 text-emerald-400 border border-emerald-500/30 flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
                      <span>Valid Repo</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Validation Hint */}
              <div className="mt-1.5 text-xs font-mono flex items-center gap-1">
                {simulatedState === 'invalid' ? (
                  <span className="text-red-400 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">error</span>
                    Repository not found or private. Ensure URL is correct or grant GitHub OAuth permissions.
                  </span>
                ) : simulatedState === 'unsupported' ? (
                  <span className="text-amber-300 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px] text-amber-400">warning</span>
                    Kernel repository detected. Code browsing enabled; live browser sandbox preview is unsupported for C/Kernel targets.
                  </span>
                ) : (
                  <span className="text-slate-500 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px] text-slate-400">info</span>
                    Owner: <strong className="text-slate-300">shadcn-ui</strong> • Repository: <strong className="text-slate-300">ui</strong> • Access: <strong className="text-emerald-400">Public</strong>
                  </span>
                )}
              </div>
            </div>

            {/* Branch & Commit Selector Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-label-md font-label text-slate-300 mb-2">
                  Branch / Reference
                </label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-2.5 text-slate-400 text-[18px]">
                    account_tree
                  </span>
                  <select
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    className="w-full bg-[#080C14] border border-border-strong text-white font-mono text-xs pl-10 pr-4 py-2.5 rounded-lg focus:border-dark-primary focus:ring-1 focus:ring-dark-primary"
                  >
                    <option value="main">main (default branch)</option>
                    <option value="canary">canary (unstable preview)</option>
                    <option value="v0.8.0">tag: v0.8.0</option>
                    <option value="v0.7.0">tag: v0.7.0</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-label-md font-label text-slate-300 mb-2">
                  Sandbox Runtime Preset
                </label>
                <div className="relative">
                  <span className="material-symbols-outlined absolute left-3 top-2.5 text-slate-400 text-[18px]">
                    memory
                  </span>
                  <select
                    value={preset}
                    onChange={(e) => setPreset(e.target.value)}
                    className="w-full bg-[#080C14] border border-border-strong text-white font-mono text-xs pl-10 pr-4 py-2.5 rounded-lg focus:border-dark-primary focus:ring-1 focus:ring-dark-primary"
                  >
                    <option value="auto">Auto-detect (Next.js 14 / Node 20)</option>
                    <option value="vite">Vite SPA (Vite + React / Vue / Svelte)</option>
                    <option value="node-generic">Generic Node.js (package.json scripts.dev)</option>
                    <option value="static">Static HTML / CSS / JS only</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Form Actions */}
            <div className="flex items-center justify-between pt-2">
              <Link to="/dashboard" className="text-xs font-mono text-slate-400 hover:text-white">
                Cancel
              </Link>

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handleImport}
                  disabled={isImporting}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-dark-surface-container-high hover:bg-slate-800 border border-border-strong text-white font-label text-sm transition-colors shadow"
                >
                  <span className="material-symbols-outlined text-[18px]">
                    {isImporting ? 'sync' : 'download'}
                  </span>
                  <span>{isImporting ? 'Importing...' : 'Import to GitView'}</span>
                </button>

                <button
                  type="submit"
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-sm transition-colors shadow-md active:translate-y-px"
                >
                  <span className="material-symbols-outlined text-[18px]">rocket_launch</span>
                  <span>Launch Cloud Workspace</span>
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Section: Your GitHub Repositories (Live API) */}
        <section className="bg-dark-surface-container border border-border-strong rounded-xl p-6 sm:p-8 shadow-xl space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <h2 className="font-headline text-headline-md font-bold text-white flex items-center gap-2">
                <svg className="w-5 h-5 fill-current text-slate-300" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
                <span>Your GitHub Repositories</span>
              </h2>
              <p className="text-body-sm text-slate-400 mt-1">
                Browse and import public repositories from your connected GitHub account.
              </p>
            </div>

            {user?.githubConnected && (
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3 top-2.5 text-slate-500 text-[16px]">
                  search
                </span>
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Filter repositories..."
                  className="bg-[#080C14] border border-border-strong focus:border-dark-primary text-xs font-mono text-white pl-8 pr-3 py-2 rounded-lg placeholder:text-slate-500"
                />
              </div>
            )}
          </div>

          {!user?.githubConnected ? (
            <div className="p-8 rounded-lg bg-[#080C14] border border-border-subtle text-center space-y-4">
              <div className="w-12 h-12 rounded-full bg-slate-800/60 border border-slate-700 flex items-center justify-center mx-auto text-slate-300">
                <svg className="w-6 h-6 fill-current" viewBox="0 0 24 24">
                  <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
                </svg>
              </div>
              <div className="space-y-1">
                <h3 className="text-white font-headline font-semibold text-sm">
                  GitHub Account Not Connected
                </h3>
                <p className="text-xs text-slate-400 max-w-sm mx-auto">
                  Connect your GitHub account to access your repositories directly and import them with a single click.
                </p>
              </div>
              <button
                type="button"
                onClick={() => { window.location.href = authService.getGitHubAuthUrl(); }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-xs font-medium transition-colors shadow"
              >
                <span>Connect GitHub Account</span>
              </button>
            </div>
          ) : loadingGithub ? (
            <div className="space-y-3">
              {[1, 2, 3].map((n) => (
                <div key={n} className="p-4 rounded-lg bg-[#080C14] border border-border-subtle h-20 animate-pulse"></div>
              ))}
            </div>
          ) : githubError ? (
            <div className="p-4 rounded-lg bg-red-950/40 border border-red-500/40 flex items-center justify-between text-xs font-mono text-red-300">
              <span>{githubError}</span>
              <button
                onClick={() => fetchGitHubRepos(page)}
                className="px-2.5 py-1 rounded bg-red-900/60 hover:bg-red-800 text-white"
              >
                Retry
              </button>
            </div>
          ) : filteredGitHubRepos.length === 0 ? (
            <div className="p-6 rounded-lg bg-[#080C14] border border-border-subtle text-center text-xs font-mono text-slate-400">
              No repositories found matching your filter.
            </div>
          ) : (
            <div className="space-y-3">
              {filteredGitHubRepos.map((repo) => {
                const isThisImporting = importingRepoName === repo.fullName;
                return (
                  <div
                    key={repo.githubRepoId}
                    className="p-4 rounded-lg bg-[#080C14] border border-border-subtle hover:border-border-strong transition-all flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                  >
                    <div className="space-y-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-blue-400 text-[18px]">
                          folder
                        </span>
                        <h4 className="font-headline font-semibold text-white text-sm truncate">
                          {repo.fullName}
                        </h4>
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-dark-surface-container border border-border-subtle text-slate-400">
                          {repo.defaultBranch}
                        </span>
                      </div>
                      <p className="text-xs text-slate-400 line-clamp-1">
                        {repo.description || 'No description provided.'}
                      </p>
                      <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500">
                        {repo.primaryLanguage && (
                          <span className="flex items-center gap-1 text-slate-400">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
                            {repo.primaryLanguage}
                          </span>
                        )}
                        <span>★ {repo.stars}</span>
                        <span>⑂ {repo.forks}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      {repo.isImported ? (
                        <div className="flex items-center gap-2">
                          <span className="px-2.5 py-1 rounded text-xs font-mono bg-emerald-950/70 border border-emerald-500/40 text-emerald-400 flex items-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">check</span>
                            <span>Imported</span>
                          </span>
                          <Link
                            to="/dashboard"
                            className="px-3 py-1 rounded bg-[#090D16] hover:bg-slate-800 border border-border-subtle text-slate-300 text-xs font-mono transition-colors"
                          >
                            View
                          </Link>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleImportGitHubRepo(repo.fullName)}
                          disabled={isThisImporting}
                          className="px-3.5 py-1.5 rounded-lg bg-dark-primary hover:bg-blue-500 disabled:opacity-50 text-white font-label text-xs font-medium transition-colors flex items-center gap-1.5 shadow"
                        >
                          <span className="material-symbols-outlined text-[14px]">
                            {isThisImporting ? 'hourglass_empty' : 'add'}
                          </span>
                          <span>{isThisImporting ? 'Importing...' : 'Import'}</span>
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Pagination controls */}
              <div className="flex items-center justify-between pt-4 border-t border-border-subtle text-xs font-mono text-slate-400">
                <button
                  type="button"
                  onClick={() => fetchGitHubRepos(Math.max(1, page - 1))}
                  disabled={page <= 1 || loadingGithub}
                  className="px-3 py-1.5 rounded bg-[#080C14] hover:bg-dark-surface-container-high border border-border-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  ← Previous
                </button>

                <span>Page {page}</span>

                <button
                  type="button"
                  onClick={() => fetchGitHubRepos(page + 1)}
                  disabled={githubRepos.length < 10 || loadingGithub}
                  className="px-3 py-1.5 rounded bg-[#080C14] hover:bg-dark-surface-container-high border border-border-subtle disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </section>

        {/* Quick Test Corner: Test Interactive States */}
        <div className="p-4 rounded-xl bg-dark-surface-container border border-border-subtle">
          <div className="flex items-center justify-between mb-3 text-xs font-mono">
            <span className="text-slate-400 uppercase">Simulate Error &amp; Edge States:</span>
            <span className="text-slate-500">Click to preview interactive behavior</span>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-mono">
            <button
              type="button"
              onClick={() => setManualState('invalid')}
              className={`px-3 py-1.5 rounded bg-[#080C14] hover:bg-dark-surface-container-high border transition-colors ${
                simulatedState === 'invalid'
                  ? 'border-red-500 text-red-300 font-bold'
                  : 'border-red-500/30 text-red-400'
              }`}
            >
              Simulate 404 / Invalid URL
            </button>
            <button
              type="button"
              onClick={() => setManualState('unsupported')}
              className={`px-3 py-1.5 rounded bg-[#080C14] hover:bg-dark-surface-container-high border transition-colors ${
                simulatedState === 'unsupported'
                  ? 'border-amber-500 text-amber-300 font-bold'
                  : 'border-amber-500/30 text-amber-400'
              }`}
            >
              Simulate Unsupported Binary/Repo
            </button>
            <button
              type="button"
              onClick={() => setManualState('valid')}
              className={`px-3 py-1.5 rounded bg-[#080C14] hover:bg-dark-surface-container-high border transition-colors ${
                simulatedState === 'valid'
                  ? 'border-emerald-500 text-emerald-300 font-bold'
                  : 'border-emerald-500/30 text-emerald-400'
              }`}
            >
              Reset to Valid Repository
            </button>
          </div>
        </div>
      </main>
    </AppLayout>
  );
};
