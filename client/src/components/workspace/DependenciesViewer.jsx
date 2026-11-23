import React, { useState, useEffect, useCallback } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';
import { repoService } from '../../services/repoService';

export const DependenciesViewer = () => {
  const { currentRepo, currentBranch, treeCache } = useWorkspace();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all'); // 'all' | 'prod' | 'dev'
  const [pkgData, setPkgData] = useState({ prod: [], dev: [], peer: [] });
  const [pkgMeta, setPkgMeta] = useState(null);
  const [manifestPath, setManifestPath] = useState('package.json');

  const loadDependencies = useCallback(async () => {
    if (!currentRepo?.id) return;

    setLoading(true);
    setError(null);

    const targetBranch = currentBranch || currentRepo.defaultBranch || 'main';

    try {
      // 1. Resolve application project root dynamically
      let resolvedRoot = '';
      try {
        const detection = await repoService.detectRepository(currentRepo.id, targetBranch);
        if (detection?.projectRoot) {
          resolvedRoot = detection.projectRoot;
        }
      } catch {
        // Fallback: Check treeCache for nested package.json if detection was unreachable
      }

      if (!resolvedRoot && treeCache) {
        const rootHasPkg = (treeCache[''] || []).some(
          (e) => e.name?.toLowerCase() === 'package.json' && e.type === 'file'
        );
        if (!rootHasPkg) {
          for (const [dir, entries] of Object.entries(treeCache)) {
            if (dir && entries?.some((e) => e.name?.toLowerCase() === 'package.json' && e.type === 'file')) {
              resolvedRoot = dir;
              break;
            }
          }
        }
      }

      const targetPath = resolvedRoot ? `${resolvedRoot}/package.json` : 'package.json';
      setManifestPath(targetPath);

      const data = await repoService.getFileContent(currentRepo.id, targetPath, targetBranch);
      const rawContent = typeof data === 'string' ? data : (data?.content || '');

      if (!rawContent) {
        setError({
          type: 'NOT_FOUND',
          message: `No package.json manifest found at '${targetPath}'.`,
        });
        setLoading(false);
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawContent);
      } catch (parseErr) {
        setError({
          type: 'PARSE_ERROR',
          message: `Failed to parse package.json: Invalid JSON syntax (${parseErr.message})`,
        });
        setLoading(false);
        return;
      }

      const prod = Object.entries(parsed.dependencies || {})
        .map(([name, version]) => ({ name, version: String(version), type: 'production' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const dev = Object.entries(parsed.devDependencies || {})
        .map(([name, version]) => ({ name, version: String(version), type: 'development' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const peer = Object.entries(parsed.peerDependencies || {})
        .map(([name, version]) => ({ name, version: String(version), type: 'peer' }))
        .sort((a, b) => a.name.localeCompare(b.name));

      setPkgData({ prod, dev, peer });
      setPkgMeta({
        name: parsed.name || currentRepo.name,
        version: parsed.version || '0.0.0',
        license: parsed.license || 'Unspecified',
      });
    } catch (err) {
      setError({
        type: 'FETCH_ERROR',
        message: err.message || 'No package.json file found in this repository.',
      });
    } finally {
      setLoading(false);
    }
  }, [currentRepo?.id, currentRepo?.defaultBranch, currentRepo?.name, currentBranch, treeCache]);

  useEffect(() => {
    loadDependencies();
  }, [loadDependencies]);

  const allDeps = [
    ...pkgData.prod,
    ...pkgData.dev,
    ...pkgData.peer,
  ];

  const displayedDeps = filter === 'prod'
    ? pkgData.prod
    : filter === 'dev'
    ? pkgData.dev
    : filter === 'peer'
    ? pkgData.peer
    : allDeps;

  if (loading) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-8 space-y-3 font-mono">
        <span className="w-8 h-8 border-2 border-dark-primary border-t-transparent rounded-full animate-spin"></span>
        <span className="text-xs text-slate-400">Inspecting package.json dependencies...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="no-manifest-state" className="flex-1 overflow-y-auto p-8 max-w-2xl mx-auto flex flex-col items-center justify-center text-center space-y-4 font-body">
        <div className="w-12 h-12 rounded-full bg-slate-800/80 border border-border-strong text-slate-400 flex items-center justify-center">
          <span className="material-symbols-outlined text-[24px]">
            {error.type === 'PARSE_ERROR' ? 'code_off' : 'package_2'}
          </span>
        </div>
        <div className="space-y-1">
          <h3 className="font-headline font-semibold text-white text-base">
            {error.type === 'PARSE_ERROR' ? 'Malformed package.json' : 'No Dependencies Manifest'}
          </h3>
          <p className="text-xs font-mono text-slate-400 max-w-md">
            {error.message}
          </p>
        </div>
        <button
          onClick={loadDependencies}
          className="px-4 py-2 rounded-lg bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-300 font-label text-xs transition-colors flex items-center gap-1.5"
        >
          <span className="material-symbols-outlined text-[15px]">refresh</span>
          <span>Retry Inspection</span>
        </button>
      </div>
    );
  }

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
            Parsed from {manifestPath} • {pkgMeta?.name || currentRepo?.name} (v{pkgMeta?.version || '0.0.0'}) • License: {pkgMeta?.license}
          </p>
        </div>

        <button
          onClick={loadDependencies}
          className="text-slate-400 hover:text-white p-1.5 rounded hover:bg-slate-800 transition-colors self-start sm:self-center"
          title="Refresh package.json"
        >
          <span className="material-symbols-outlined text-[18px]">refresh</span>
        </button>
      </div>

      {/* Category Filter Tabs */}
      <div className="flex items-center gap-2 text-xs font-mono">
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
          Runtime ({pkgData.prod.length})
        </button>
        <button
          onClick={() => setFilter('dev')}
          className={`px-3 py-1 rounded transition-colors ${
            filter === 'dev'
              ? 'bg-dark-primary text-white font-medium'
              : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
          }`}
        >
          DevDependencies ({pkgData.dev.length})
        </button>
        {pkgData.peer.length > 0 && (
          <button
            onClick={() => setFilter('peer')}
            className={`px-3 py-1 rounded transition-colors ${
              filter === 'peer'
                ? 'bg-dark-primary text-white font-medium'
                : 'bg-dark-surface-container text-slate-400 hover:text-white border border-border-subtle'
            }`}
          >
            Peer ({pkgData.peer.length})
          </button>
        )}
      </div>

      {/* Empty State for Filter */}
      {displayedDeps.length === 0 ? (
        <div className="p-8 text-center text-xs font-mono text-slate-500 border border-dashed border-border-subtle rounded-lg">
          No dependencies found in this category.
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
                        : 'bg-amber-950/60 text-amber-400 border border-amber-500/20'
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
