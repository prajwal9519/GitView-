import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { LanguageBreakdown } from '../components/telemetry/LanguageBreakdown';
import { DependencyAuditTable } from '../components/telemetry/DependencyAuditTable';
import { TelemetryCard } from '../components/telemetry/TelemetryCard';
import { repoService } from '../services/repoService';
import { sandboxService } from '../services/sandboxService';

export const RepoDetailsPage = () => {
  const { repoId } = useParams();
  const [repo, setRepo] = useState(null);
  const [dependencies, setDependencies] = useState([]);
  const [telemetry, setTelemetry] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = repoId || 'shadcn-ui-ui';
    Promise.all([
      repoService.getRepositoryById(id),
      repoService.getDependencies(id),
      sandboxService.getTelemetry(id)
    ]).then(([r, deps, telem]) => {
      setRepo(r);
      setDependencies(deps);
      setTelemetry(telem);
    }).finally(() => {
      setLoading(false);
    });
  }, [repoId]);

  if (loading || !repo) {
    return (
      <AppLayout>
        <div className="flex items-center justify-center flex-1">
          <span className="w-8 h-8 border-2 border-dark-primary border-t-transparent rounded-full animate-spin"></span>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      {/* Top Header */}
      <header className="h-16 px-8 border-b border-border-subtle flex items-center justify-between bg-dark-surface shrink-0">
        <div className="flex items-center gap-3">
          <span className="material-symbols-outlined text-blue-400 text-[22px]">source</span>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-headline text-headline-sm font-semibold text-white">
                {repo.owner} / {repo.name}
              </h1>
              <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-emerald-950/70 border border-emerald-500/30 text-emerald-400">
                {repo.isPrivate ? 'Private' : 'Public'}
              </span>
            </div>
            <p className="text-xs font-mono text-slate-400">
              Commit: {repo.latestCommit || '9a1f2b4'} • branch: {repo.defaultBranch || 'main'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to={`/workspace/${repo.id}`}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-label-md font-medium transition-colors shadow-sm"
          >
            <span className="material-symbols-outlined text-[16px]">play_arrow</span>
            <span>Open in Workspace</span>
          </Link>
        </div>
      </header>

      <main className="p-8 max-w-6xl w-full mx-auto space-y-8 flex-1">
        {/* Top Metrics Strip */}
        <section className="grid grid-cols-2 md:grid-cols-4 gap-4 font-mono text-xs">
          <div className="p-4 rounded-xl bg-dark-surface-container border border-border-subtle">
            <span className="text-slate-500 block mb-1">DETECTED FRAMEWORK</span>
            <span className="text-base font-bold text-white flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-blue-400"></span>
              <span>{repo.framework || 'Next.js 14.1.0'}</span>
            </span>
            <span className="text-[11px] text-slate-400 mt-1 block">App Router • Turbopack</span>
          </div>

          <div className="p-4 rounded-xl bg-dark-surface-container border border-border-subtle">
            <span className="text-slate-500 block mb-1">PREVIEW SANDBOX</span>
            <span className="text-base font-bold text-emerald-400 flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
              <span>Active (Port {repo.port || 3000})</span>
            </span>
            <span className="text-[11px] text-slate-400 mt-1 block">HMR websocket connected</span>
          </div>

          <div className="p-4 rounded-xl bg-dark-surface-container border border-border-subtle">
            <span className="text-slate-500 block mb-1">TOTAL DEPENDENCIES</span>
            <span className="text-base font-bold text-white">
              {repo.dependenciesCount || 18} direct / {repo.totalDependenciesCount || 142} total
            </span>
            <span className="text-[11px] text-emerald-400 mt-1 block">
              {repo.vulnerabilitiesCount || 0} vulnerabilities found
            </span>
          </div>

          <div className="p-4 rounded-xl bg-dark-surface-container border border-border-subtle">
            <span className="text-slate-500 block mb-1">REPO METRICS</span>
            <span className="text-base font-bold text-white">
              {repo.filesCount?.toLocaleString() || '4,281'} files • {repo.size || '38.4 MB'}
            </span>
            <span className="text-[11px] text-slate-400 mt-1 block">
              AST parse time: {repo.astParseTime || '380ms'}
            </span>
          </div>
        </section>

        {/* Language Distribution Breakdown */}
        <LanguageBreakdown breakdown={repo.languageBreakdown} />

        {/* Dependency Tree Inspector Table */}
        <DependencyAuditTable dependencies={dependencies} />

        {/* Sandbox Health Telemetry Card */}
        <TelemetryCard telemetry={telemetry} />
      </main>
    </AppLayout>
  );
};
