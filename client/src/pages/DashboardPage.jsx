import React, { useState, useEffect } from 'react';
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

  useEffect(() => {
    Promise.all([
      repoService.getRepositories(),
      repoService.getHistorySessions()
    ]).then(([repos, sessions]) => {
      setRepositories(repos);
      setHistorySessions(sessions);
    }).finally(() => {
      setLoading(false);
    });
  }, []);

  const handleQuickSubmit = (e) => {
    e.preventDefault();
    if (quickUrl.trim()) {
      navigate(`/workspace?repo=${encodeURIComponent(quickUrl)}`);
    }
  };

  const filteredRepos = repositories.filter((r) => {
    if (filterType === 'running') return r.status === 'running';
    if (filterType === 'ready') return r.status === 'ready' || r.status === 'idle';
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

          {/* Repository Grid */}
          {loading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {[1, 2, 3].map((n) => (
                <div key={n} className="p-5 rounded-xl bg-dark-surface-container border border-border-subtle h-48 animate-pulse"></div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              {filteredRepos.map((repo) => (
                <RepoCard key={repo.id} repo={repo} />
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
