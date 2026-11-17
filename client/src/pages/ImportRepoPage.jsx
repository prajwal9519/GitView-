import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { AppLayout } from '../components/layout/AppLayout';
import { repoService } from '../services/repoService';

export const ImportRepoPage = () => {
  const navigate = useNavigate();
  const [repoUrl, setRepoUrl] = useState('https://github.com/shadcn-ui/ui');
  const [branch, setBranch] = useState('main');
  const [preset, setPreset] = useState('auto');
  const [simulatedState, setSimulatedState] = useState('valid'); // 'valid' | 'invalid' | 'unsupported'
  const [analyzing, setAnalyzing] = useState(false);

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

  const handleLaunch = (e) => {
    e.preventDefault();
    if (simulatedState === 'invalid') {
      alert('Cannot launch an invalid or unreachable repository.');
      return;
    }
    navigate(`/workspace?repo=${encodeURIComponent(repoUrl)}&branch=${branch}`);
  };

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
          <span className="text-slate-400">
            Connected account: <span className="text-white font-medium">github.com/alex-rivera</span>
          </span>
        </div>
      </header>

      <main className="p-8 max-w-4xl w-full mx-auto space-y-8 flex-1">
        {/* Primary Import Wizard Container */}
        <div className="bg-dark-surface-container border border-border-strong rounded-xl p-6 sm:p-8 shadow-xl">
          <div className="mb-6">
            <h2 className="font-headline text-headline-md font-bold text-white">
              Target Repository Specification
            </h2>
            <p className="text-body-sm text-slate-400 mt-1">
              GitView clones the abstract syntax tree and initializes an in-browser WebContainer sandbox.
            </p>
          </div>

          <form onSubmit={handleLaunch} className="space-y-6">
            {/* Repository URL Input */}
            <div>
              <label className="block text-label-md font-label text-slate-300 mb-2">
                GitHub Repository URL <span className="text-red-400">*</span>
              </label>
              <div className="relative">
                <span className="material-symbols-outlined absolute left-3.5 top-3 text-slate-400 text-[18px]">
                  link
                </span>
                <input
                  type="text"
                  value={repoUrl}
                  onChange={(e) => handleInputChange(e.target.value)}
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
                    <option value="main">main (default, latest commit 9a1f2b)</option>
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

            {/* Real-Time Repository Pre-Flight Analysis Card */}
            <div className="p-5 rounded-lg bg-[#080C14] border border-border-subtle space-y-4">
              <div className="flex items-center justify-between border-b border-border-subtle pb-3">
                <div className="flex items-center gap-2 text-xs font-mono text-slate-300">
                  <span className="w-2 h-2 rounded-full bg-blue-400 animate-ping"></span>
                  <span>Pre-flight Repository Analysis</span>
                </div>
                <span className={`text-xs font-mono ${simulatedState === 'invalid' ? 'text-red-400' : 'text-emerald-400'}`}>
                  {simulatedState === 'invalid' ? 'Analysis Failed' : 'Ready to Sandbox'}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs font-mono">
                <div>
                  <span className="text-slate-500 block">FRAMEWORK</span>
                  <span className="text-white font-semibold flex items-center gap-1 mt-0.5">
                    <span className="w-2 h-2 rounded-full bg-blue-400"></span>
                    {simulatedState === 'unsupported' ? 'C / Linux' : 'Next.js 14.1'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">PACKAGE MANAGER</span>
                  <span className="text-white font-semibold mt-0.5 block">
                    {simulatedState === 'unsupported' ? 'make' : 'pnpm v8.15'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">DEV PORT DETECTED</span>
                  <span className="text-emerald-400 font-semibold mt-0.5 block">
                    {simulatedState === 'unsupported' ? 'N/A' : 'localhost:3000'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block">EST. BOOT TIME</span>
                  <span className="text-accent font-semibold mt-0.5 block">
                    {simulatedState === 'unsupported' ? 'Code only' : '~1.4 seconds'}
                  </span>
                </div>
              </div>

              {/* Simulated Terminal Log Stream */}
              <div className="p-3 bg-[#05070B] rounded border border-border-subtle font-mono text-[11px] text-slate-400 space-y-1">
                <p className="text-slate-500">Checking repository manifest...</p>
                {simulatedState === 'invalid' ? (
                  <p className="text-red-400">✖ Failed to clone repository metadata: 404 Not Found</p>
                ) : simulatedState === 'unsupported' ? (
                  <>
                    <p className="text-amber-400">⚠ No package.json detected in root.</p>
                    <p className="text-slate-400">ℹ AST parsing will run in viewer-only mode.</p>
                  </>
                ) : (
                  <>
                    <p className="text-emerald-400">✔ Found package.json: {`{ "scripts": { "dev": "next dev" } }`}</p>
                    <p className="text-emerald-400">✔ WebContainer isolation supported (no C++ native addon requirements)</p>
                    <p className="text-blue-400">ℹ 18 client-side dependencies will hydrate in isolated iframe</p>
                  </>
                )}
              </div>
            </div>

            {/* Form Submissions */}
            <div className="flex items-center justify-between pt-2">
              <Link to="/dashboard" className="text-xs font-mono text-slate-400 hover:text-white">
                Cancel
              </Link>

              <button
                type="submit"
                className="inline-flex items-center gap-2 px-6 py-3 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-label-lg transition-colors shadow-md active:translate-y-px"
              >
                <span className="material-symbols-outlined text-[18px]">rocket_launch</span>
                <span>Launch Cloud Workspace</span>
              </button>
            </div>
          </form>
        </div>

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
