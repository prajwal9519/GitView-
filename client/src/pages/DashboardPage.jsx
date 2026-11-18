import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { MetricsBar } from '../components/dashboard/MetricsBar';
import { RepoCard } from '../components/dashboard/RepoCard';
import { HistoryTable } from '../components/dashboard/HistoryTable';
import { repoService } from '../services/repoService';

export const DashboardPage = () => {
  const navigate = useNavigate();
  const [repositories, setRepositories] = useState([]);
  const [historySessions, setHistorySessions] = useState([]);
  const [quickUrl, setQuickUrl] = useState('');
  const [filterType, setFilterType] = useState('all'); // 'all' | 'running' | 'ready'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [repos, sessions] = await Promise.all([
        repoService.getRepositories(),
        repoService.getHistorySessions(),
      ]);
      setRepositories(repos);
      setHistorySessions(sessions);
    } catch (err) {
      setError(err.message || 'Failed to load imported repositories');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDashboardData();
  }, [loadDashboardData]);

  const handleDeleteRepo = async (id) => {
    try {
      await repoService.deleteRepository(id);
      setRepositories((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      alert(err.message || 'Failed to remove repository');
    }
  };

  const handleQuickSubmit = (e) => {
    e.preventDefault();
    if (quickUrl.trim()) {
      navigate(`/workspace?repo=${encodeURIComponent(quickUrl)}`);
    }
  };

  const filteredRepos = repositories.filter((r) => {
    if (filterType === 'running') return r.status === 'running';
    if (filterType === 'ready') return r.status === 'ready' || r.status === 'idle' || !r.status;
    return true;
  });

  return (
    <AppLayout>
      {/* Top Bar */}
      <header className="h-16 px-8 border-b border-border-subtle flex items-center justify-between bg-dark-surface shrink-0">
        <div className="flex items-center gap-4">
          <h1 className="font-headline text-headline-sm font-semibold text-white">
            Dashboard Overview
          </h1>
          <span className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-mono bg-dark-surface-container border border-border-subtle text-slate-300">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            <span>Sandbox Engine Online</span>
          </span>
        </div>

        <div className="flex items-center gap-3">
          {/* Quick URL Bar */}
          <form onSubmit={handleQuickSubmit} className="relative hidden lg:flex items-center">
            <span className="material-symbols-outlined absolute left-3 text-slate-500 text-[18px]">
              search
            </span>
            <input
              type="text"
              value={quickUrl}
              onChange={(e) => setQuickUrl(e.target.value)}
              placeholder="Paste repo URL to preview..."
              className="w-80 bg-dark-surface-container border border-border-subtle focus:border-dark-primary focus:ring-1 focus:ring-dark-primary text-xs font-mono text-white pl-9 pr-14 py-2 rounded-lg placeholder:text-slate-500 transition-colors"
            />
            <span className="absolute right-2 text-[10px] font-mono text-slate-500 bg-[#090D16] px-1.5 py-0.5 rounded border border-border-subtle">
              ↵ Enter
            </span>
          </form>

          <Link
            to="/import"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-primary hover:bg-blue-500 text-white text-xs font-label font-medium transition-colors"
          >
            <span className="material-symbols-outlined text-[16px]">add</span>
            <span>Import Repo</span>
          </Link>
        </div>
      </header>

      {/* Main Workspace Section */}
      <main className="p-8 max-w-7xl w-full mx-auto space-y-8 flex-1">
        {/* Metrics Bar */}
        <MetricsBar />

        {/* Error State Banner */}
        {error && (
          <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/50 flex items-center justify-between text-red-300 text-xs font-mono">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-red-400 text-[20px]">error</span>
              <span>{error}</span>
            </div>
            <button
              onClick={loadDashboardData}
              className="px-3 py-1 rounded bg-red-900/60 hover:bg-red-800/60 text-white font-mono text-xs transition-colors"
            >
              Retry
            </button>
          </div>
        )}

        {/* Active & Recent Previews */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="font-headline text-headline-sm font-semibold text-white">
                Recent Repositories &amp; Previews
              </h2>
              <p className="text-body-sm text-slate-400">
                Instantly re-open inspected repositories or manage active sandboxes
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="relative">
                <select
                  value={filterType}
                  onChange={(e) => setFilterType(e.target.value)}
                  className="px-3 py-1.5 rounded text-xs font-mono bg-dark-surface-container border border-border-subtle text-slate-300 hover:text-white focus:outline-none focus:border-dark-primary"
                >
                  <option value="all">Filter: All</option>
                  <option value="running">Filter: Running Only</option>
                  <option value="ready">Filter: Idle / Ready</option>
                </select>
              </div>
            </div>
          </div>

          {/* Repository Grid: Loading, Empty, or Cards */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {[1, 2, 3].map((n) => (
                <div key={n} className="p-5 rounded-xl bg-dark-surface-container border border-border-subtle h-48 animate-pulse flex flex-col justify-between">
                  <div className="space-y-3">
                    <div className="h-5 bg-slate-800/80 rounded w-2/3"></div>
                    <div className="h-3 bg-slate-800/50 rounded w-full"></div>
                    <div className="h-3 bg-slate-800/50 rounded w-4/5"></div>
                  </div>
                  <div className="h-8 bg-slate-800/40 rounded w-full"></div>
                </div>
              ))}
            </div>
          ) : filteredRepos.length === 0 ? (
            <div className="p-10 rounded-xl bg-dark-surface-container border border-border-subtle text-center space-y-4">
              <div className="w-14 h-14 rounded-full bg-dark-surface-container-high border border-border-subtle flex items-center justify-center mx-auto text-blue-400">
                <span className="material-symbols-outlined text-[28px]">folder_open</span>
              </div>
              <div className="space-y-1">
                <h3 className="font-headline font-semibold text-white text-base">
                  No repositories imported yet
                </h3>
                <p className="text-body-sm text-slate-400 max-w-md mx-auto">
                  Import any public GitHub repository to explore its AST, inspect dependencies, and launch browser sandboxes.
                </p>
              </div>
              <Link
                to="/import"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-dark-primary hover:bg-blue-500 text-white text-xs font-label font-medium transition-colors shadow-md"
              >
                <span className="material-symbols-outlined text-[16px]">add</span>
                <span>Import Your First Repository</span>
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredRepos.map((repo) => (
                <RepoCard key={repo.id} repo={repo} onDelete={handleDeleteRepo} />
              ))}
            </div>
          )}
        </section>

        {/* History Table */}
        <section className="space-y-4">
          <h2 className="font-headline text-headline-sm font-semibold text-white">
            Preview Session History
          </h2>
          <HistoryTable sessions={historySessions} />
        </section>
      </main>
    </AppLayout>
  );
};
