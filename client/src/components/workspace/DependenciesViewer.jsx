import React from 'react';
import { mockDependencies } from '../../data/mockRepositories';

export const DependenciesViewer = () => {
  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 font-body">
      <div className="flex items-center justify-between border-b border-border-subtle pb-4">
        <div>
          <h2 className="font-headline text-headline-sm text-white font-semibold">
            Runtime Dependencies ({mockDependencies.length})
          </h2>
          <p className="text-xs text-slate-400 font-mono mt-0.5">
            Parsed from package.json • 0 vulnerabilities found
          </p>
        </div>
        <span className="px-2.5 py-1 rounded bg-emerald-950/70 border border-emerald-500/30 text-emerald-400 text-xs font-mono">
          Audit: 100% Passed
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 font-mono text-xs">
        {mockDependencies.map((dep) => (
          <div
            key={dep.name}
            className="p-3 bg-[#080C14] border border-border-subtle rounded-lg flex items-center justify-between hover:border-border-strong transition-colors"
          >
            <div>
              <div className="text-white font-medium">{dep.name}</div>
              <div className="text-[11px] text-slate-500">License: {dep.license} • {dep.type}</div>
            </div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 rounded bg-dark-surface-container text-blue-300">
                {dep.version}
              </span>
              <span className="text-[10px] text-emerald-400">Pass</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
