import React from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';

export const ReadmeViewer = () => {
  const { currentRepo, setMainViewMode } = useWorkspace();

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-3xl space-y-6 font-body text-slate-300">
      <div className="border-b border-border-subtle pb-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="w-8 h-8 rounded bg-dark-primary flex items-center justify-center text-white font-mono font-bold text-xs">
            {currentRepo.name.slice(0, 2)}
          </span>
          <h1 className="font-headline text-display-md text-white font-bold">
            {currentRepo.fullName}
          </h1>
        </div>
        <p className="text-body-md text-slate-400">
          {currentRepo.description}
        </p>
      </div>

      <div className="space-y-4 text-body-sm leading-relaxed">
        <h2 className="font-headline text-headline-sm text-white font-semibold">
          Core Architectural Principles
        </h2>
        <ul className="list-disc list-inside space-y-1.5 text-slate-300 font-body">
          <li>Built on top of Radix UI headless accessible primitives.</li>
          <li>Engineered using Tailwind CSS utility tokens with full CSS variables support.</li>
          <li>Not an npm dependency; code is directly owned and edited in your project directory.</li>
          <li>Full dark-mode compatibility out of the box with zero runtime CSS overhead.</li>
        </ul>

        <h2 className="font-headline text-headline-sm text-white font-semibold pt-4">
          Instant CLI Setup
        </h2>
        <div className="p-3.5 bg-[#090D16] border border-border-subtle rounded-lg font-mono text-xs text-emerald-400 flex items-center justify-between">
          <span>$ npx shadcn-ui@latest init</span>
          <span className="text-[11px] text-slate-500 font-mono">Terminal Command</span>
        </div>

        <div className="pt-6 border-t border-border-subtle flex items-center gap-3">
          <button
            onClick={() => setMainViewMode('code')}
            className="px-4 py-2 rounded bg-dark-primary hover:bg-blue-500 text-white font-label text-xs transition-colors flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">code</span>
            <span>Inspect Source Files</span>
          </button>
          <button
            onClick={() => setMainViewMode('deps')}
            className="px-4 py-2 rounded bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-300 font-label text-xs transition-colors flex items-center gap-1.5"
          >
            <span className="material-symbols-outlined text-[16px]">package_2</span>
            <span>View Dependencies</span>
          </button>
        </div>
      </div>
    </div>
  );
};
