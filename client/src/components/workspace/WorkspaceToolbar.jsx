import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useWorkspace } from '../../context/WorkspaceContext';
import { Modal } from '../common/Modal';
import { previewService } from '../../services/previewService';

export const WorkspaceToolbar = ({ onOpenCommandPalette }) => {
  const navigate = useNavigate();
  const {
    currentRepo,
    currentBranch,
    switchBranch,
    mainViewMode,
    setMainViewMode,
    previewState,
    previewPort,
    triggerSandboxRefresh,
    isPreviewOpen,
    setIsPreviewOpen,
    fetchDirectory,
    loadFile,
    activeTab,
    dependenciesCount,
    loadingDependencies,
    stopActivePreview,
    previewStopError,
  } = useWorkspace();

  const [isBranchDropdownOpen, setIsBranchDropdownOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isLeaveModalOpen, setIsLeaveModalOpen] = useState(false);
  const [isStoppingPreview, setIsStoppingPreview] = useState(false);
  const [toolbarStopError, setToolbarStopError] = useState(null);

  const handleLogoClick = () => {
    if (previewState === 'running') {
      setIsLeaveModalOpen(true);
    } else {
      navigate('/dashboard');
    }
  };

  const handleToolbarStop = async () => {
    if (isStoppingPreview || (previewState || '').toLowerCase() === 'stopping') return;
    setIsStoppingPreview(true);
    setToolbarStopError(null);
    try {
      await stopActivePreview();
    } catch (err) {
      console.error('Failed to stop preview from toolbar:', err.message);
      setToolbarStopError(err.message || 'Failed to stop preview.');
      setTimeout(() => setToolbarStopError(null), 5000);
    } finally {
      setIsStoppingPreview(false);
    }
  };

  const handleStopAndLeave = async () => {
    setIsStoppingPreview(true);
    try {
      await stopActivePreview();
    } catch {
      // Continue navigation
    } finally {
      setIsStoppingPreview(false);
      setIsLeaveModalOpen(false);
      navigate('/dashboard');
    }
  };

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
    const s = (previewState || 'idle').toLowerCase();
    if (['starting', 'pending', 'fetching', 'building'].includes(s)) {
      return {
        bg: 'bg-amber-950/70 border-amber-500/40 text-amber-400',
        dot: 'bg-amber-400 animate-pulse',
        text: 'Preview: Booting...',
      };
    }
    if (s === 'running') {
      return {
        bg: 'bg-emerald-950/70 border-emerald-500/40 text-emerald-400',
        dot: 'bg-emerald-400 animate-pulse',
        text: previewPort ? `Preview: Running (${previewPort})` : 'Preview: Running',
      };
    }
    if (s === 'stopping') {
      return {
        bg: 'bg-amber-950/70 border-amber-500/40 text-amber-400',
        dot: 'bg-amber-400',
        text: 'Preview: Stopping...',
      };
    }
    if (s === 'failed') {
      return {
        bg: 'bg-red-950/70 border-red-500/40 text-red-400',
        dot: 'bg-red-400',
        text: 'Preview: Failed',
      };
    }
    if (s === 'expired') {
      return {
        bg: 'bg-slate-800 border-slate-700 text-slate-400',
        dot: 'bg-slate-400',
        text: 'Preview: Expired',
      };
    }
    return {
      bg: 'bg-blue-950/70 border-blue-500/40 text-blue-300',
      dot: 'bg-blue-400',
      text: 'Preview: Idle',
    };
  };

  const status = getStatusPillClasses();

  const isPreviewActiveOrBooting = [
    'running',
    'starting',
    'pending',
    'fetching',
    'building',
    'stopping',
  ].includes((previewState || '').toLowerCase());

  return (
    <header className="h-14 bg-[#0A0E18] border-b border-border-subtle px-4 flex items-center justify-between shrink-0 z-30 select-none">
      {/* Left: Logo, Repository ID, Branch Picker */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleLogoClick}
          className="flex items-center gap-2 hover:opacity-85 transition-opacity"
          title="Back to Dashboard"
        >
          <div className="w-7 h-7 rounded bg-gradient-to-tr from-dark-primary to-accent flex items-center justify-center text-white font-mono font-bold text-xs shadow-sm">
            GV
          </div>
        </button>

        <div className="h-4 w-px bg-border-strong"></div>

        {/* Repo Identifier */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <a
            href={currentRepo?.owner ? `https://github.com/${currentRepo.owner}` : '#'}
            target="_blank"
            rel="noreferrer"
            className="text-slate-400 hover:text-white transition-colors"
          >
            {currentRepo?.owner || 'Repository'}
          </a>
          <span className="text-slate-600">/</span>
          <Link
            to={currentRepo?.id ? `/repo/${currentRepo.id}` : '#'}
            className="text-white font-semibold hover:text-blue-400 transition-colors flex items-center gap-1"
          >
            <span>{currentRepo?.name || 'Workspace'}</span>
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
                {(currentRepo?.branches || [currentBranch]).map((branch) => (
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
                      {branch === (currentRepo?.defaultBranch || 'main') ? 'HEAD' : 'branch'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <span className="hidden lg:inline-flex items-center gap-1 text-[11px] text-slate-500 font-mono ml-1">
            <span className="material-symbols-outlined text-[14px]">commit</span>
            <span>{(currentRepo?.latestCommitSha || currentRepo?.latestCommit || 'HEAD').slice(0, 7)}</span>
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
          title="View Dependencies"
        >
          <span className="material-symbols-outlined text-[15px]">package_2</span>
          <span>Dependencies</span>
          <span
            data-testid="dependencies-count-badge"
            className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-800 text-slate-400"
          >
            {loadingDependencies
              ? '...'
              : dependenciesCount !== null && dependenciesCount !== undefined
              ? dependenciesCount
              : '—'}
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

        {/* Interactive Real Preview Status Pill */}
        <div
          onClick={() => setIsPreviewOpen(!isPreviewOpen)}
          title="Toggle Live Preview Panel"
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-mono border cursor-pointer hover:opacity-90 transition-colors shrink-0 ${status.bg}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`}></span>
          <span>{status.text}</span>
        </div>

        {/* Always-Visible Stop Preview Button */}
        {isPreviewActiveOrBooting && (
          <button
            onClick={handleToolbarStop}
            disabled={isStoppingPreview || (previewState || '').toLowerCase() === 'stopping'}
            data-testid="toolbar-stop-preview-btn"
            className="flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-mono font-medium transition-colors border shadow-sm shrink-0 bg-red-950/80 hover:bg-red-900/80 text-red-200 border-red-500/50 hover:border-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
            title="Stop Running Preview and Release Docker Resources"
          >
            <span
              className={`material-symbols-outlined text-[15px] ${
                isStoppingPreview || (previewState || '').toLowerCase() === 'stopping'
                  ? 'animate-spin'
                  : 'text-red-400'
              }`}
            >
              {isStoppingPreview || (previewState || '').toLowerCase() === 'stopping'
                ? 'progress_activity'
                : 'stop'}
            </span>
            <span className="hidden sm:inline">
              {isStoppingPreview || (previewState || '').toLowerCase() === 'stopping'
                ? 'Stopping...'
                : 'Stop Preview'}
            </span>
            <span className="sm:hidden">
              {isStoppingPreview || (previewState || '').toLowerCase() === 'stopping'
                ? 'Stop...'
                : 'Stop'}
            </span>
          </button>
        )}

        {/* Toolbar Stop Error Message */}
        {(toolbarStopError || previewStopError) && (
          <div
            data-testid="toolbar-stop-error"
            className="hidden lg:flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono bg-red-950/90 border border-red-500 text-red-300"
            title={toolbarStopError || previewStopError}
          >
            <span className="material-symbols-outlined text-[13px]">error</span>
            <span className="truncate max-w-[140px]">{toolbarStopError || previewStopError}</span>
          </div>
        )}

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

      {/* Confirmation Modal when Leaving Workspace with Active Preview */}
      <Modal isOpen={isLeaveModalOpen} onClose={() => setIsLeaveModalOpen(false)} maxWidth="max-w-md">
        <div className="p-5">
          <div className="w-10 h-10 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-3">
            <span className="material-symbols-outlined text-[22px]">warning</span>
          </div>
          <h3 className="font-headline text-base font-bold text-white">
            Active Preview Running
          </h3>
          <p className="text-xs text-slate-300 mt-2 leading-relaxed">
            A live container preview is currently active for{' '}
            <span className="text-white font-semibold">{currentRepo?.name || 'this repository'}</span>.
            Navigating away will keep it running in the background until the 15-minute idle timeout.
          </p>
          <div className="mt-5 flex flex-col gap-2">
            <button
              onClick={handleStopAndLeave}
              disabled={isStoppingPreview}
              className="w-full px-4 py-2 bg-red-600 hover:bg-red-500 text-white font-medium text-xs font-mono rounded-lg transition-colors flex items-center justify-center gap-2 shadow"
            >
              <span className="material-symbols-outlined text-[16px]">
                {isStoppingPreview ? 'hourglass_top' : 'stop_circle'}
              </span>
              <span>{isStoppingPreview ? 'Stopping Preview...' : 'Stop Preview & Leave'}</span>
            </button>
            <button
              onClick={() => {
                setIsLeaveModalOpen(false);
                navigate('/dashboard');
              }}
              className="w-full px-4 py-2 bg-dark-surface-container-high hover:bg-slate-700 text-slate-200 text-xs font-mono rounded-lg transition-colors"
            >
              Keep Running & Leave
            </button>
            <button
              onClick={() => setIsLeaveModalOpen(false)}
              className="w-full px-4 py-1.5 text-slate-400 hover:text-white text-xs font-mono transition-colors"
            >
              Stay in Workspace
            </button>
          </div>
        </div>
      </Modal>
    </header>
  );
};
