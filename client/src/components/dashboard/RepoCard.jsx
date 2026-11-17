import React from 'react';
import { Link } from 'react-router-dom';

export const RepoCard = ({ repo }) => {
  const isRunning = repo.status === 'running';

  return (
    <article
      className={`p-5 rounded-xl bg-dark-surface-container border transition-all flex flex-col justify-between shadow-lg relative group ${
        isRunning
          ? 'border-blue-500/40 hover:border-blue-400'
          : 'border-border-subtle hover:border-border-strong'
      }`}
    >
      {isRunning ? (
        <div className="absolute top-4 right-4 flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-mono bg-emerald-950/70 border border-emerald-500/40 text-emerald-400">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>Running: {repo.port || 3000}</span>
        </div>
      ) : (
        <div className="absolute top-4 right-4">
          <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-400 border border-slate-700">
            {repo.status === 'ready' ? 'Ready' : 'Idle'}
          </span>
        </div>
      )}

      <div>
        <div className="flex items-center gap-2 mb-2">
          <span className="material-symbols-outlined text-blue-400 text-[20px]">
            {isRunning ? 'layers' : 'code'}
          </span>
          <h3 className="font-headline font-semibold text-white text-base truncate">
            {repo.fullName}
          </h3>
        </div>

        <p className="text-body-sm text-slate-300 line-clamp-2 mb-4">
          {repo.description}
        </p>

        <div className="flex flex-wrap items-center gap-2 mb-4 text-xs font-mono">
          {repo.tags?.map((tag) => (
            <span
              key={tag}
              className="px-2 py-0.5 rounded bg-[#090D16] text-slate-300 border border-border-subtle"
            >
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="pt-4 border-t border-border-subtle flex items-center justify-between text-xs">
        <span className="font-mono text-slate-500">
          branch: {repo.defaultBranch || 'main'}
        </span>
        <div className="flex items-center gap-2">
          <Link
            to={`/repo/${repo.id}`}
            className="px-2.5 py-1 rounded bg-[#090D16] hover:bg-dark-surface-container-high border border-border-subtle text-slate-300 transition-colors font-mono"
          >
            Inspect
          </Link>
          <Link
            to={`/workspace/${repo.id}`}
            className="px-3 py-1 rounded bg-dark-primary hover:bg-blue-500 text-white font-medium transition-colors flex items-center gap-1"
          >
            <span>Open</span>
            <span className="material-symbols-outlined text-[14px]">arrow_forward</span>
          </Link>
        </div>
      </div>
    </article>
  );
};
