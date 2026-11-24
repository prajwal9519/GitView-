import React, { useState } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';

export const DependenciesViewer = () => {
  const {
    currentRepo,
    currentBranch,
    dependenciesData,
    dependenciesCount,
    loadingDependencies,
    dependenciesError,
    fetchDependencies,
  } = useWorkspace();

  const [filter, setFilter] = useState('all'); // 'all' | 'prod' | 'dev' | 'peer' | 'optional'
  const [searchQuery, setSearchQuery] = useState('');

  // 1. Loading State
  if (loadingDependencies && !dependenciesData) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-3 font-mono">
        <span className="w-8 h-8 border-2 border-dark-primary border-t-transparent rounded-full animate-spin"></span>
        <span className="text-xs text-slate-400">Inspecting package dependencies...</span>
      </div>
    );
  }

  // 2. Error States (Malformed JSON, Rate Limit, Auth, Network)
  if (dependenciesError) {
    const isMalformed = dependenciesError.code === 'MALFORMED_MANIFEST' || dependenciesError.status === 422;
    const isRateLimited = dependenciesError.code === 'GITHUB_RATE_LIMITED' || dependenciesError.status === 429;
    const isForbidden = dependenciesError.code === 'FORBIDDEN' || dependenciesError.code === 'GITHUB_TOKEN_REVOKED';

    return (
      <div
        data-testid="no-manifest-state"
        className="flex-1 overflow-y-auto p-8 max-w-2xl mx-auto flex flex-col items-center justify-center text-center space-y-4 font-body"
      >
        <div
          className={`w-14 h-14 rounded-full flex items-center justify-center border ${
            isMalformed
              ? 'bg-amber-500/10 border-amber-500/20 text-amber-400'
              : isForbidden
              ? 'bg-red-500/10 border-red-500/20 text-red-400'
              : 'bg-slate-800/80 border-border-strong text-slate-400'
          }`}
        >
          <span className="material-symbols-outlined text-[26px]">
            {isMalformed ? 'code_off' : isRateLimited ? 'hourglass_top' : isForbidden ? 'lock' : 'cloud_off'}
          </span>
        </div>

        <div className="space-y-1.5">
          <h3 className="font-headline font-semibold text-white text-base">
            {isMalformed
              ? 'Malformed package.json'
              : isRateLimited
              ? 'GitHub Rate Limit Exceeded'
              : isForbidden
              ? 'Access Denied'
              : 'Dependency Inspection Failed'}
          </h3>
          <p className="text-xs font-mono text-slate-300 max-w-md leading-relaxed">
            {dependenciesError.message || 'Unable to inspect repository dependencies.'}
          </p>
          {isRateLimited && (
            <p className="text-[11px] font-mono text-slate-400 mt-1">
              Connect a personal GitHub account in Settings to bypass shared unauthenticated rate limits.
            </p>
          )}
        </div>

        <button
          onClick={() => fetchDependencies(currentBranch)}
          className="px-4 py-2 rounded-lg bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-300 font-label text-xs transition-colors flex items-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[15px]">refresh</span>
          <span>Retry Inspection</span>
        </button>
      </div>
    );
  }

  // 3. Static Site / No Manifest Found State (Clean Informational State)
  if (dependenciesData && !dependenciesData.hasManifest) {
    return (
      <div
        data-testid="no-manifest-state"
        className="flex-1 overflow-y-auto p-8 max-w-2xl mx-auto flex flex-col items-center justify-center text-center space-y-5 font-body"
      >
        <div className="w-14 h-14 rounded-full bg-slate-800/60 border border-border-subtle text-slate-400 flex items-center justify-center">
          <span className="material-symbols-outlined text-[26px]">package_2</span>
        </div>

        <div className="space-y-2 max-w-md">
          <h3 className="font-headline font-semibold text-white text-base">
            No Dependencies Manifest
          </h3>
          <p className="text-xs font-mono text-slate-300 leading-relaxed">
            No package.json manifest found. This repository is a static web application and does not declare npm dependencies.
          </p>
          <p className="text-[11px] font-body text-slate-500 leading-relaxed">
            Standard HTML, CSS, client-side JavaScript, and external CDN scripts are served directly by the static preview runtime without an npm build pipeline.
          </p>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] font-mono">
          <span className="px-2.5 py-1 rounded-md bg-[#080C14] border border-border-subtle text-slate-400">
            FRAMEWORK: <span className="text-white font-semibold">{dependenciesData.framework || 'STATIC'}</span>
          </span>
          <span className="px-2.5 py-1 rounded-md bg-[#080C14] border border-border-subtle text-slate-400">
            PROJECT ROOT: <span className="text-white font-semibold">{dependenciesData.projectRoot || '/'}</span>
          </span>
          <span className="px-2.5 py-1 rounded-md bg-[#080C14] border border-border-subtle text-slate-400">
            PACKAGES: <span className="text-blue-400 font-semibold">0 declared</span>
          </span>
        </div>

        <button
          onClick={() => fetchDependencies(currentBranch)}
          className="px-4 py-2 rounded-lg bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-300 font-label text-xs transition-colors flex items-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[15px]">refresh</span>
          <span>Re-inspect Manifest</span>
        </button>
      </div>
    );
  }

  // 4. Valid Manifest State (Dependencies List)
  const prod = dependenciesData?.dependencies || [];
  const dev = dependenciesData?.devDependencies || [];
  const peer = dependenciesData?.peerDependencies || [];
  const optional = dependenciesData?.optionalDependencies || [];
  const allDeps = [...prod, ...dev, ...peer, ...optional];

  const categoryDeps =
    filter === 'prod'
      ? prod
      : filter === 'dev'
      ? dev
      : filter === 'peer'
      ? peer
      : filter === 'optional'
      ? optional
      : allDeps;

  const displayedDeps = searchQuery.trim()
    ? categoryDeps.filter((dep) => dep.name.toLowerCase().includes(searchQuery.trim().toLowerCase()))
    : categoryDeps;

  const pkgMeta = dependenciesData?.packageMetadata;
  const manifestPath = dependenciesData?.manifestPath || 'package.json';

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 font-body">
      {/* Header Info */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between border-b border-border-subtle pb-4 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-headline text-headline-sm text-white font-semibold">
              Project Dependencies
            </h2>
            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-dark-surface-container text-blue-300 border border-border-subtle">
              Total: {allDeps.length}
            </span>
          </div>
          <p data-testid="manifest-path" className="text-xs text-slate-400 font-mono mt-0.5">
            Parsed from {manifestPath} • {pkgMeta?.name || currentRepo?.name} (v{pkgMeta?.version || '0.0.0'}) • License: {pkgMeta?.license || 'Unspecified'}
          </p>
        </div>

        <button
          onClick={() => fetchDependencies(currentBranch)}
          className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800 transition-colors self-start sm:self-center"
          title="Refresh dependencies"
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
        </button>
      </div>

      {/* Controls: Category Filter Tabs & Search */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
          <button
            onClick={() => setFilter('all')}
            className={`px-3 py-1 rounded transition-colors ${
              filter === 'all'
                ? 'bg-dark-primary text-white font-medium'
                : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
            }`}
          >
            All ({allDeps.length})
          </button>
          <button
            onClick={() => setFilter('prod')}
            className={`px-3 py-1 rounded transition-colors ${
              filter === 'prod'
                ? 'bg-dark-primary text-white font-medium'
                : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
            }`}
          >
            Runtime ({prod.length})
          </button>
          <button
            onClick={() => setFilter('dev')}
            className={`px-3 py-1 rounded transition-colors ${
              filter === 'dev'
                ? 'bg-dark-primary text-white font-medium'
                : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
            }`}
          >
            DevDependencies ({dev.length})
          </button>
          {peer.length > 0 && (
            <button
              onClick={() => setFilter('peer')}
              className={`px-3 py-1 rounded transition-colors ${
                filter === 'peer'
                  ? 'bg-dark-primary text-white font-medium'
                  : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
              }`}
            >
              Peer ({peer.length})
            </button>
          )}
          {optional.length > 0 && (
            <button
              onClick={() => setFilter('optional')}
              className={`px-3 py-1 rounded transition-colors ${
                filter === 'optional'
                  ? 'bg-dark-primary text-white font-medium'
                  : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
              }`}
            >
              Optional ({optional.length})
            </button>
          )}
        </div>

        {/* Search Input */}
        <div className="relative flex items-center min-w-[200px]">
          <span className="material-symbols-outlined absolute left-2.5 text-slate-500 text-[14px]">search</span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search packages..."
            className="w-full bg-[#05080E] border border-border-subtle text-xs font-mono text-white pl-7 pr-3 py-1 rounded placeholder:text-slate-600 focus:outline-none focus:border-dark-primary transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2 text-slate-500 hover:text-white"
            >
              <span className="material-symbols-outlined text-[13px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Empty State for Filter/Search */}
      {displayedDeps.length === 0 ? (
        <div className="p-8 text-center text-xs font-mono text-slate-500 border border-dashed border-border-subtle rounded-lg">
          {searchQuery ? `No packages matching "${searchQuery}".` : 'No dependencies declared in this category.'}
        </div>
      ) : (
        /* Dependencies Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 font-mono text-xs">
          {displayedDeps.map((dep) => (
            <div
              key={`${dep.type}-${dep.name}`}
              className="p-3 bg-[#080C14] border border-border-subtle rounded-lg flex items-center justify-between hover:border-border-strong transition-colors"
            >
              <div className="truncate pr-2">
                <div className="text-white font-medium truncate" title={dep.name}>
                  {dep.name}
                </div>
                <div className="text-[10px] text-slate-500 mt-0.5">
                  <span
                    className={`inline-block px-1.5 py-0.2 rounded text-[9px] uppercase ${
                      dep.type === 'production'
                        ? 'bg-blue-950/60 text-blue-400 border border-blue-500/20'
                        : dep.type === 'development'
                        ? 'bg-purple-950/60 text-purple-400 border border-purple-500/20'
                        : dep.type === 'peer'
                        ? 'bg-amber-950/60 text-amber-400 border border-amber-500/20'
                        : 'bg-emerald-950/60 text-emerald-400 border border-emerald-500/20'
                    }`}
                  >
                    {dep.type}
                  </span>
                </div>
              </div>

              <div className="shrink-0 flex items-center">
                <span className="px-2 py-0.5 rounded bg-dark-surface-container text-slate-300 border border-border-subtle text-[11px]">
                  {dep.version}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

