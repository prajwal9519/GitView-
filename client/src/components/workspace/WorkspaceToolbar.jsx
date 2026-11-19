import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useWorkspace } from '../../context/WorkspaceContext';

export const WorkspaceToolbar = ({ onOpenCommandPalette }) => {
  const {
    currentRepo,
    currentBranch,
    switchBranch,
    mainViewMode,
    setMainViewMode,
    previewState,
    cyclePreviewState,
    triggerSandboxRefresh,
    isPreviewOpen,
    setIsPreviewOpen,
    fetchDirectory,
    loadFile,
    activeTab,
  } = useWorkspace();

  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const handleRefreshClick = () => {
    setIsRefreshing(true);
    fetchDirectory('', true);
    if (activeTab) {
      loadFile(activeTab);
    }
    triggerSandboxRefresh();
    setTimeout(() => setIsRefreshing(false), 600);
  };

  const getStatusPillClasses = () => {
    if (previewState === 'loading') {
      return {
        bg: 'bg-amber-950/70 border-amber-500/40 text-amber-400',
        dot: 'bg-amber-400 animate-pulse',
        text: 'Preview: Booting...'
      };
    }
    if (previewState === 'failed') {
      return {
        bg: 'bg-red-950/70 border-red-500/40 text-red-400',
        dot: 'bg-red-400',
        text: 'Preview: Failed (exit 1)'
      };
    }
    return {
      bg: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-400',
      dot: 'bg-emerald-400 animate-pulse',
      text: `Preview: Running (${currentRepo.port || 3000})`
    };
  };

  const status = getStatusPillClasses();

  return (
    <header className="h-14 bg-[#0A0E18] border-b border-border-subtle px-4 flex items-center justify-between shrink-0 z-30 select-none">
      {/* Left: Logo, Repository ID, Branch Picker */}
      <div className="flex items-center gap-3">
        <Link
          to="/dashboard"
          className="flex items-center gap-2 hover:opacity-85 transition-opacity"
          title="Back to Dashboard"
        >
          <div className="w-7 h-7 rounded bg-gradient-to-tr from-dark-primary to-accent flex items-center justify-center text-white font-mono font-bold text-xs shadow-sm">
            GV
          </div>
        </Link>

        <div className="h-4 w-px bg-border-strong"></div>

        {/* Repo Identifier */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <a
            href={`https://github.com/${currentRepo.owner}`}
            target="_blank"
            rel="noreferrer"
            className="text-slate-400 hover:text-white transition-colors"
          >
            {currentRepo.owner}
          </a>
          <span className="text-slate-600">/</span>
          <Link
            to={`/repo/${currentRepo.id}`}
            className="text-white font-semibold hover:text-blue-400 transition-colors flex items-center gap-1"
          >
            <span>{currentRepo.name}</span>
            <span className="material-symbols-outlined text-[13px] text-slate-500">open_in_new</span>
          </Link>

          {/* Branch Selector with Dropdown */}
          <div className="relative ml-2">
            <button
              onClick={() => setIsBranchDropdownOpen(!isBranchDropdownOpen)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded bg-[#090D16] hover:bg-dark-surface-container border border-border-subtle text-slate-200 text-xs font-mono transition-colors"
            >
              <span className="material-symbols-outlined text-[15px] text-blue-400">account_tree</span>
              <span>{currentBranch}</span>
              <span className="material-symbols-outlined text-[13px] text-slate-400">arrow_drop_down</span>
            </button>

            {isBranchDropdownOpen && (
              <div
                className="absolute left-0 top-full mt-1.5 w-56 bg-dark-surface-container border border-border-strong rounded-lg shadow-2xl py-1.5 z-50 text-xs font-mono"
                onMouseLeave={() => setIsBranchDropdownOpen(false)}
              >
                <div className="px-3 py-1.5 text-[10px] text-slate-500 uppercase tracking-wider border-b border-border-subtle">
                  Switch Branch or Tag
                </div>
                {currentRepo.branches?.map((branch) => (
                  <button
                    key={branch}
                    onClick={() => {
                      switchBranch(branch);
                      setIsBranchDropdownOpen(false);
                    }}
                    className={`w-full px-3 py-1.5 text-left flex items-center justify-between hover:bg-dark-primary/20 hover:text-blue-400 transition-colors ${
                      branch === currentBranch ? 'text-white bg-dark-surface-container-high/40' : 'text-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${branch === currentBranch ? 'bg-blue-400' : 'bg-transparent'}`}></span>
                      {branch}
                    </span>
                    <span className="text-[10px] text-slate-500">
                      {branch === currentRepo.defaultBranch ? 'HEAD' : 'branch'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="hidden lg:inline-flex items-center gap-1 text-[11px] text-slate-500 font-mono ml-1">
            <span className="material-symbols-outlined text-[14px]">commit</span>
            <span>{(currentRepo.latestCommitSha || currentRepo.latestCommit || 'HEAD').slice(0, 7)}</span>
          </span>
        </div>
      </div>

      {/* Center: Main Workspace Tabs (Code / README / Dependencies / Telemetry) */}
      <div className="hidden md:flex items-center p-1 rounded-lg bg-[#070A10] border border-border-subtle text-xs font-label">
        <button
          onClick={() => setMainViewMode('code')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded transition-all ${
            mainViewMode === 'code'
              ? 'bg-dark-surface-container text-white font-medium border border-border-subtle shadow-sm'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <span className="material-symbols-outlined text-[15px] text-blue-400">code</span>
          <span>Code</span>
        </button>

        <button
          onClick={() => setMainViewMode('readme')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded transition-all ${
            mainViewMode === 'readme'
              ? 'bg-dark-surface-container text-white font-medium border border-border-subtle shadow-sm'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <span className="material-symbols-outlined text-[15px]">menu_book</span>
          <span>README</span>
        </button>

        <button
          onClick={() => setMainViewMode('deps')}
          className={`flex items-center gap-1.5 px-3 py-1 rounded transition-all ${
            mainViewMode === 'deps'
              ? 'bg-dark-surface-container text-white font-medium border border-border-subtle shadow-sm'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          <span className="material-symbols-outlined text-[15px]">package_2</span>
          <span>Dependencies</span>
          <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-800 text-slate-400">
            {currentRepo.dependenciesCount || 18}
          </span>
        </button>

        <Link
          to={`/repo/${currentRepo.id}`}
          className="flex items-center gap-1.5 px-3 py-1 rounded text-slate-400 hover:text-white transition-all"
        >
          <span className="material-symbols-outlined text-[15px]">analytics</span>
          <span>Telemetry</span>
        </Link>
      </div>

      {/* Right: Preview Status, Refresh Sandbox, Toggle Preview, Settings */}
      <div className="flex items-center gap-2.5">
        {/* Command Palette Trigger */}
        <button
          onClick={onOpenCommandPalette}
          className="hidden xl:flex items-center gap-1.5 text-slate-400 hover:text-slate-200 px-2.5 py-1 rounded bg-[#090D16] border border-border-subtle text-xs font-mono"
        >
          <span className="material-symbols-outlined text-[14px]">search</span>
          <span>⌘K</span>
        </button>

        {/* Interactive Preview Trigger Badge */}
        <div
          onClick={() => setIsPreviewOpen(!isPreviewOpen)}
          title="Toggle Live Preview Panel"
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border cursor-pointer hover:opacity-90 transition-colors ${
            isPreviewOpen
              ? 'bg-emerald-950/70 border-emerald-500/40 text-emerald-400'
              : 'bg-blue-950/70 border-blue-500/40 text-blue-300'
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              isPreviewOpen ? 'bg-emerald-400 animate-pulse' : 'bg-blue-400'
            }`}
          ></span>
          <span>{isPreviewOpen ? 'Preview: Active' : 'Preview: Launch'}</span>
        </div>

        {/* Hot Reload Sandbox Button */}
        <button
          onClick={handleRefreshClick}
          className="p-1.5 rounded bg-[#090D16] hover:bg-dark-surface-container border border-border-subtle text-slate-300 hover:text-white transition-colors"
          title="Hot Reload Sandbox"
        >
          <span className={`material-symbols-outlined text-[16px] ${isRefreshing ? 'animate-spin text-accent' : ''}`}>
            refresh
          </span>
        </button>

        {/* Toggle Live Preview Pane */}
        <button
          onClick={() => setIsPreviewOpen(!isPreviewOpen)}
          className={`flex items-center gap-1 px-2.5 py-1 rounded border text-xs font-mono transition-colors ${
            isPreviewOpen
              ? 'bg-[#090D16] hover:bg-dark-surface-container border-border-subtle text-slate-300'
              : 'bg-dark-surface-container-high border-border-strong text-white'
          }`}
          title="Toggle Preview Panel"
        >
          <span className="material-symbols-outlined text-[15px] text-accent">splitscreen</span>
          <span className="hidden sm:inline">{isPreviewOpen ? 'Preview' : 'Open Preview'}</span>
        </button>

        {/* Settings Icon Link */}
        <Link
          to="/settings"
          className="p-1.5 rounded bg-[#090D16] hover:bg-dark-surface-container border border-border-subtle text-slate-300 hover:text-white transition-colors"
          title="Workspace & Container Settings"
        >
          <span className="material-symbols-outlined text-[16px]">settings</span>
        </Link>
      </div>
    </header>
  );
};
