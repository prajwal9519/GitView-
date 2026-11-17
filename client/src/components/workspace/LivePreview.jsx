import React, { useState } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';

export const LivePreview = ({ width = 480 }) => {
  const {
    activeTab,
    previewState,
    setPreviewState,
    previewDevice,
    setPreviewDevice,
    triggerSandboxRefresh,
    terminalLogs
  } = useWorkspace();

  const [taps, setTaps] = useState(0);

  const previewName = activeTab.replace(/\.(tsx|ts|json|md)$/, '');

  return (
    <aside
      className="bg-[#0A0E18] flex flex-col shrink-0 overflow-hidden h-full border-l border-border-subtle"
      style={{ width: `${width}px`, minWidth: '320px', maxWidth: '800px' }}
    >
      {/* Browser Top Window Bar */}
      <div className="h-10 bg-[#080C14] border-b border-border-subtle px-3 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">
          {/* Window traffic dots */}
          <div className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/70 inline-block"></span>
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500/70 inline-block"></span>
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70 inline-block"></span>
          </div>

          {/* Browser Address Bar */}
          <div className="ml-1.5 flex items-center gap-1.5 bg-[#05070D] border border-border-subtle rounded px-2 py-0.5 text-xs font-mono text-slate-300 w-44 sm:w-56">
            <span className="material-symbols-outlined text-[13px] text-emerald-400">lock</span>
            <span className="text-[11px] truncate">localhost:3000/preview/{previewName}</span>
          </div>
        </div>

        {/* Browser Frame Actions */}
        <div className="flex items-center gap-1 text-slate-400">
          <button
            onClick={triggerSandboxRefresh}
            className="hover:text-white p-1 rounded hover:bg-slate-800 transition-colors"
            title="Reload Frame"
          >
            <span className="material-symbols-outlined text-[15px]">refresh</span>
          </button>
          <button
            onClick={() => setPreviewDevice('mobile')}
            className={`p-1 rounded transition-colors ${
              previewDevice === 'mobile' ? 'text-blue-400 bg-slate-800' : 'hover:text-white hover:bg-slate-800'
            }`}
            title="Mobile Viewport (340px)"
          >
            <span className="material-symbols-outlined text-[15px]">smartphone</span>
          </button>
          <button
            onClick={() => setPreviewDevice('desktop')}
            className={`p-1 rounded transition-colors ${
              previewDevice === 'desktop' ? 'text-blue-400 bg-slate-800' : 'hover:text-white hover:bg-slate-800'
            }`}
            title="Responsive Desktop Viewport"
          >
            <span className="material-symbols-outlined text-[15px]">laptop</span>
          </button>
          <button
            onClick={() => window.open('about:blank', '_blank')}
            className="hover:text-white p-1 rounded hover:bg-slate-800 transition-colors"
            title="Pop out Preview"
          >
            <span className="material-symbols-outlined text-[15px]">open_in_new</span>
          </button>
        </div>
      </div>

      {/* Preview Body Container: Supports 3 States */}
      <div className="flex-1 bg-[#05070D] flex flex-col relative overflow-hidden">
        {/* STATE 1: RUNNING */}
        {previewState === 'running' && (
          <div className="flex-1 flex flex-col p-6 overflow-y-auto">
            <div
              className="space-y-6 mx-auto w-full transition-all"
              style={{ maxWidth: previewDevice === 'mobile' ? '340px' : '100%' }}
            >
              <div className="border-b border-border-subtle pb-4 flex items-center justify-between">
                <div>
                  <span className="text-[10px] font-mono text-accent uppercase tracking-wider">
                    WebContainer Sandbox v2
                  </span>
                  <h3 className="font-headline text-base font-bold text-white mt-0.5">
                    {previewName.charAt(0).toUpperCase() + previewName.slice(1)} Component Preview
                  </h3>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-emerald-950/80 text-emerald-400 border border-emerald-500/40">
                  200 OK
                </span>
              </div>

              {/* Interactive Component Specimen */}
              <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle space-y-4 shadow-xl">
                <div className="flex items-center justify-between text-xs font-mono text-slate-400">
                  <span>Variants:</span>
                  <span className="text-slate-500">HMR Active</span>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button className="px-3.5 py-1.5 bg-blue-600 hover:bg-blue-500 text-white rounded text-xs font-medium transition-colors shadow">
                    Default Primary
                  </button>
                  <button className="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 border border-border-subtle rounded text-xs font-medium transition-colors">
                    Secondary
                  </button>
                  <button className="px-3.5 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded text-xs font-medium transition-colors">
                    Destructive
                  </button>
                </div>

                <div className="text-xs font-mono text-slate-400 pt-2">Size Variants:</div>
                <div className="flex items-center gap-2">
                  <button className="px-2 py-1 bg-blue-600 text-white rounded text-[10px]">sm</button>
                  <button className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs">default</button>
                  <button className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-semibold">lg</button>
                </div>

                {/* Click Interaction Test */}
                <div className="pt-4 border-t border-border-subtle flex items-center justify-between text-xs font-mono">
                  <span className="text-slate-400">Interaction state:</span>
                  <button
                    onClick={() => setTaps((t) => t + 1)}
                    className="px-3 py-1 bg-dark-surface hover:bg-slate-800 border border-border-subtle text-accent rounded font-semibold active:scale-95 transition-all"
                  >
                    Taps: {taps}
                  </button>
                </div>
              </div>

              {/* Terminal Output Drawer */}
              <div className="rounded-lg bg-[#080B12] border border-border-subtle p-3 text-[11px] font-mono space-y-1">
                <div className="flex items-center justify-between text-slate-500 pb-1 border-b border-border-subtle mb-1">
                  <span>SANDBOX CONSOLE</span>
                  <span className="text-emerald-400">Ready in 184ms</span>
                </div>
                {terminalLogs.map((log, i) => (
                  <p
                    key={i}
                    className={
                      log.includes('Local')
                        ? 'text-emerald-400'
                        : log.includes('vite')
                        ? 'text-slate-400'
                        : 'text-slate-500'
                    }
                  >
                    {log}
                  </p>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* STATE 2: LOADING / BOOTING */}
        {previewState === 'loading' && (
          <div className="absolute inset-0 bg-[#070A10] flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-full border-2 border-accent border-t-transparent animate-spin mb-4"></div>
            <h3 className="font-headline text-headline-sm font-semibold text-white">
              Starting WebContainer Sandbox...
            </h3>
            <p className="text-xs font-mono text-slate-400 mt-2 max-w-xs">
              Allocating in-browser Node 20 runtime, extracting dependencies, and binding port 3000.
            </p>
            <div className="mt-4 px-3 py-1.5 rounded bg-dark-surface-container border border-border-subtle text-xs font-mono text-amber-300">
              $ pnpm run dev --port 3000
            </div>
          </div>
        )}

        {/* STATE 3: FAILED */}
        {previewState === 'failed' && (
          <div className="absolute inset-0 bg-[#090507] flex flex-col items-center justify-center p-8 text-center">
            <div className="w-12 h-12 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[28px]">error</span>
            </div>
            <h3 className="font-headline text-headline-sm font-semibold text-white">
              Sandbox Build Failed
            </h3>
            <p className="text-xs font-mono text-slate-400 mt-2 max-w-xs">
              Process exited with code 1. Missing peer dependency or invalid export in package.json.
            </p>
            <div className="mt-4 p-3 rounded bg-red-950/40 border border-red-500/30 text-left font-mono text-[11px] text-red-300 max-w-xs overflow-x-auto">
              <code>
                Error: Cannot find module '@radix-ui/react-primitive'
                <br />
                at NodeResolution (runtime.js:142)
              </code>
            </div>
            <button
              onClick={() => setPreviewState('running')}
              className="mt-4 px-4 py-2 bg-dark-surface-container hover:bg-slate-800 border border-border-subtle text-white rounded text-xs font-mono transition-colors"
            >
              Restart Container
            </button>
          </div>
        )}
      </div>

      {/* State Simulator Footer for UI Testing */}
      <div className="p-2 border-t border-border-subtle bg-[#080B12] flex items-center justify-between text-[10px] font-mono text-slate-400 shrink-0 select-none">
        <span>Simulate State:</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPreviewState('running')}
            className={`px-2 py-0.5 rounded border transition-colors ${
              previewState === 'running'
                ? 'bg-emerald-950/80 border-emerald-500/50 text-emerald-300 font-bold'
                : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-400'
            }`}
          >
            Running
          </button>
          <button
            onClick={() => setPreviewState('loading')}
            className={`px-2 py-0.5 rounded border transition-colors ${
              previewState === 'loading'
                ? 'bg-amber-950/80 border-amber-500/50 text-amber-300 font-bold'
                : 'bg-amber-950/40 border-amber-500/30 text-amber-400'
            }`}
          >
            Booting
          </button>
          <button
            onClick={() => setPreviewState('failed')}
            className={`px-2 py-0.5 rounded border transition-colors ${
              previewState === 'failed'
                ? 'bg-red-950/80 border-red-500/50 text-red-300 font-bold'
                : 'bg-red-950/40 border-red-500/30 text-red-400'
            }`}
          >
            Failed
          </button>
        </div>
      </div>
    </aside>
  );
};
