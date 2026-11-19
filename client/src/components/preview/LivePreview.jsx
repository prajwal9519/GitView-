import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  previewService,
  PreviewStatus,
  PreviewFramework,
} from '../../services/previewService';

/**
 * GitView Phase 5 — Milestone 7, Task 6: Production Live Preview Component
 *
 * Implements hardened, container-backed preview interface:
 * - State machine: IDLE -> PENDING/FETCHING/BUILDING/STARTING -> RUNNING -> STOPPED / FAILED / EXPIRED
 * - Bounded backoff status polling with auto-cancellation on unmount or user abort
 * - Single-use bootstrap ticket redemption for iframe rendering (mode: 'iframe')
 * - Top-level new tab navigation with separate ticket redemption (mode: 'toplevel')
 * - Secure iframe sandboxing: sandbox="allow-scripts allow-forms allow-same-origin"
 * - Referrer policy: referrerPolicy="no-referrer"
 * - Live lifecycle controls: Run, Stop, Restart, Refresh, Open New Tab, Viewport Switcher
 * - Expiry countdown with visual warnings
 */
export const LivePreview = ({
  repositoryId,
  commitRef,
  repoName = 'Repository Preview',
  width = 480,
  onClose,
  initialSession = null,
}) => {
  // Session lifecycle state
  const [session, setSession] = useState(initialSession);
  const [status, setStatus] = useState(initialSession?.status || 'IDLE');
  const [iframeUrl, setIframeUrl] = useState('');
  const [isIframeLoading, setIsIframeLoading] = useState(false);
  const [viewportMode, setViewportMode] = useState('desktop'); // 'desktop' | 'mobile'

  // Error & conflict state
  const [errorInfo, setErrorInfo] = useState(null);
  const [conflictSessionId, setConflictSessionId] = useState(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);

  // Time remaining
  const [timeRemainingSeconds, setTimeRemainingSeconds] = useState(null);

  // Operation flags
  const [isActionInProgress, setIsActionInProgress] = useState(false);

  // Polling abort controller ref
  const abortControllerRef = useRef(null);
  const timerIntervalRef = useRef(null);

  // Helper to format remaining time
  const formatTimeRemaining = (seconds) => {
    if (seconds === null || seconds === undefined || seconds <= 0) return '00:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  // Expiry countdown timer
  useEffect(() => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }

    if (session?.expiresAt && status === PreviewStatus.RUNNING) {
      const updateRemaining = () => {
        const remaining = Math.max(
          0,
          Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000)
        );
        setTimeRemainingSeconds(remaining);
        if (remaining <= 0) {
          setStatus(PreviewStatus.EXPIRED);
          clearInterval(timerIntervalRef.current);
        }
      };

      updateRemaining();
      timerIntervalRef.current = setInterval(updateRemaining, 1000);
    } else {
      setTimeRemainingSeconds(null);
    }

    return () => {
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, [session?.expiresAt, status]);

  // Clean up any ongoing polling on unmount
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (timerIntervalRef.current) {
        clearInterval(timerIntervalRef.current);
      }
    };
  }, []);

  /**
   * Generates a fresh iframe bootstrap ticket and sets the iframe src
   */
  const loadIframeWithTicket = useCallback(async (sessionId) => {
    if (!sessionId) return;
    setIsIframeLoading(true);
    try {
      const ticketData = await previewService.createPreviewTicket(sessionId, 'iframe');
      setIframeUrl(ticketData.previewUrl);
    } catch (err) {
      console.error('Failed to generate iframe ticket:', err.message);
      setErrorInfo({
        code: err.code || 'TICKET_GENERATION_FAILED',
        message: err.message || 'Failed to generate bootstrap ticket for preview iframe.',
      });
    }
  }, []);

  /**
   * Starts bounded status polling for an in-flight session
   */
  const startPolling = useCallback(
    async (sessionId) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const finalSession = await previewService.pollPreviewStatus(
          sessionId,
          (updated) => {
            setSession(updated);
            setStatus(updated.status);
            if (updated.status === PreviewStatus.FAILED) {
              setErrorInfo({
                code: updated.errorCode || 'PREVIEW_FAILED',
                message: updated.errorMessage || 'Preview environment execution failed.',
              });
            }
          },
          {
            signal: controller.signal,
            initialIntervalMs: 1000,
            maxIntervalMs: 3000,
          }
        );

        setSession(finalSession);
        setStatus(finalSession.status);

        if (finalSession.status === PreviewStatus.RUNNING) {
          await loadIframeWithTicket(finalSession.id);
        } else if (finalSession.status === PreviewStatus.FAILED) {
          setErrorInfo({
            code: finalSession.errorCode || 'PREVIEW_FAILED',
            message: finalSession.errorMessage || 'Preview build or launch failed.',
          });
        }
      } catch (err) {
        if (err.message !== 'Polling aborted') {
          console.error('Status polling error:', err.message);
          setErrorInfo({
            code: err.code || 'POLLING_ERROR',
            message: err.message || 'Lost connection while checking preview status.',
          });
        }
      }
    },
    [loadIframeWithTicket]
  );

  /**
   * Action: Start / Run Preview
   */
  const handleStart = async (overrideRepoId = null) => {
    const targetRepoId = overrideRepoId || repositoryId;
    if (!targetRepoId) {
      setErrorInfo({
        code: 'MISSING_REPO_ID',
        message: 'No repository selected for live preview.',
      });
      return;
    }

    setIsActionInProgress(true);
    setErrorInfo(null);
    setConflictSessionId(null);
    setStatus(PreviewStatus.STARTING);
    setIframeUrl('');

    try {
      const newSession = await previewService.createPreview(targetRepoId, commitRef);
      setSession(newSession);
      setStatus(newSession.status);

      if (newSession.status === PreviewStatus.RUNNING) {
        await loadIframeWithTicket(newSession.id);
      } else if (newSession.status === PreviewStatus.FAILED) {
        setErrorInfo({
          code: newSession.errorCode || 'PREVIEW_FAILED',
          message: newSession.errorMessage || 'Preview build or launch failed.',
        });
      } else if (newSession.status === PreviewStatus.STOPPED) {
        // Stopped
      } else {
        startPolling(newSession.id);
      }
    } catch (err) {
      if (err.status === 409 || err.code === 'ACTIVE_SESSION_CONFLICT') {
        const activeId = err.details?.activeSessionId;
        setConflictSessionId(activeId || 'active');
        setStatus('CONFLICT');
        setErrorInfo({
          code: 'ACTIVE_SESSION_CONFLICT',
          message: 'You already have an active live preview session running.',
        });
      } else {
        setStatus(PreviewStatus.FAILED);
        setErrorInfo({
          code: err.code || 'START_FAILED',
          message: err.message || 'Failed to initiate preview session.',
        });
      }
    } finally {
      setIsActionInProgress(false);
    }
  };

  /**
   * Action: Stop active preview
   */
  const handleStop = async (sessionIdToStop = null) => {
    const targetId = sessionIdToStop || session?.id || conflictSessionId;
    if (!targetId || targetId === 'active') {
      setStatus(PreviewStatus.STOPPED);
      setSession(null);
      setIframeUrl('');
      return;
    }

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    setIsActionInProgress(true);
    try {
      const stoppedSession = await previewService.stopPreview(targetId);
      setSession(stoppedSession);
      setStatus(PreviewStatus.STOPPED);
      setIframeUrl('');
      setConflictSessionId(null);
      setErrorInfo(null);
    } catch (err) {
      // If the session was already gone or not found (404), transition cleanly to STOPPED
      if (err.status === 404 || err.code === 'SESSION_NOT_FOUND') {
        setStatus(PreviewStatus.STOPPED);
        setSession(null);
        setIframeUrl('');
        setConflictSessionId(null);
        setErrorInfo(null);
      } else {
        console.error('Stop preview error:', err.message);
        setErrorInfo({
          code: err.code || 'STOP_FAILED',
          message: err.message || 'Failed to stop preview session.',
        });
      }
    } finally {
      setIsActionInProgress(false);
    }
  };

  /**
   * Action: Resolve conflict by stopping previous session and immediately launching new preview
   */
  const handleTerminateAndRestart = async () => {
    if (conflictSessionId && conflictSessionId !== 'active') {
      try {
        await previewService.stopPreview(conflictSessionId);
      } catch (err) {
        console.warn('Could not stop conflict session:', err.message);
      }
    }
    setConflictSessionId(null);
    setErrorInfo(null);
    await handleStart();
  };

  /**
   * Action: Restart current preview
   */
  const handleRestart = async () => {
    if (session?.id) {
      try {
        await previewService.stopPreview(session.id);
      } catch {
        // Ignore stop error during restart
      }
    }
    await handleStart();
  };

  /**
   * Action: Refresh Iframe
   */
  const handleRefresh = async () => {
    if (!session?.id) return;
    await loadIframeWithTicket(session.id);
  };

  /**
   * Action: Open in New Tab (top-level navigation with mode='toplevel')
   */
  const handleOpenInNewTab = async () => {
    if (!session?.id) return;
    try {
      const ticketData = await previewService.createPreviewTicket(session.id, 'toplevel');
      if (ticketData?.previewUrl) {
        window.open(ticketData.previewUrl, '_blank', 'noopener,noreferrer');
      }
    } catch (err) {
      console.error('Failed to open preview in new tab:', err.message);
      setErrorInfo({
        code: err.code || 'NEW_TAB_FAILED',
        message: err.message || 'Failed to generate bootstrap URL for new tab.',
      });
    }
  };

  // Determine stage name for progressive loading
  const getStageTitle = () => {
    switch (status) {
      case PreviewStatus.PENDING:
        return 'Queuing Preview Environment...';
      case PreviewStatus.FETCHING:
        return 'Fetching Repository from GitHub...';
      case PreviewStatus.BUILDING:
        return 'Validating Dependencies & Building...';
      case PreviewStatus.STARTING:
        return 'Booting Container Runtime & Proxy...';
      default:
        return 'Preparing Isolated Preview...';
    }
  };

  // Format origin display for address bar
  const getDisplayUrl = () => {
    if (!session?.id) return 'preview.localhost';
    return `${session.id.slice(0, 8)}.preview.localhost:3000`;
  };

  return (
    <aside
      className="bg-[#0A0E18] flex flex-col shrink-0 overflow-hidden h-full border-l border-border-subtle"
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        minWidth: '320px',
        maxWidth: '100%',
      }}
      data-testid="live-preview-panel"
    >
      {/* Top Window Bar */}
      <div className="h-10 bg-[#080C14] border-b border-border-subtle px-3 flex items-center justify-between shrink-0 select-none">
        <div className="flex items-center gap-2">
          {/* Traffic dots */}
          <div className="flex items-center gap-1.5">
            <span
              onClick={status === PreviewStatus.RUNNING ? () => handleStop() : undefined}
              className={`w-2.5 h-2.5 rounded-full inline-block ${
                status === PreviewStatus.RUNNING
                  ? 'bg-red-500 hover:opacity-80 cursor-pointer'
                  : 'bg-red-500/70'
              }`}
              title={status === PreviewStatus.RUNNING ? 'Stop Preview' : undefined}
            />
            <span
              onClick={status === PreviewStatus.RUNNING ? handleRestart : undefined}
              className={`w-2.5 h-2.5 rounded-full inline-block ${
                status === PreviewStatus.RUNNING
                  ? 'bg-amber-500 hover:opacity-80 cursor-pointer'
                  : 'bg-amber-500/70'
              }`}
              title={status === PreviewStatus.RUNNING ? 'Restart Preview' : undefined}
            />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/70 inline-block" />
          </div>

          {/* Browser Address Bar */}
          <div className="ml-1.5 flex items-center gap-1.5 bg-[#05070D] border border-border-subtle rounded px-2 py-0.5 text-xs font-mono text-slate-300 w-44 sm:w-56 max-w-xs">
            <span
              className={`material-symbols-outlined text-[13px] ${
                status === PreviewStatus.RUNNING ? 'text-emerald-400' : 'text-slate-500'
              }`}
            >
              {status === PreviewStatus.RUNNING ? 'lock' : 'public'}
            </span>
            <span className="text-[11px] truncate">{getDisplayUrl()}</span>
          </div>

          {/* Framework Badge */}
          {session?.framework && session.framework !== PreviewFramework.UNKNOWN && (
            <span
              data-testid="framework-badge"
              className="hidden sm:inline-flex px-1.5 py-0.5 rounded text-[10px] font-mono uppercase bg-blue-950/80 text-blue-400 border border-blue-500/30"
            >
              {session.framework}
            </span>
          )}
        </div>

        {/* Toolbar Controls */}
        <div className="flex items-center gap-1 text-slate-400">
          {status === PreviewStatus.RUNNING && (
            <>
              {/* Countdown Expiry */}
              {timeRemainingSeconds !== null && (
                <div
                  className={`hidden sm:flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-mono mr-1 border ${
                    timeRemainingSeconds < 300
                      ? 'bg-amber-950/80 border-amber-500/40 text-amber-300 animate-pulse'
                      : 'bg-[#05070D] border-border-subtle text-slate-400'
                  }`}
                  title="Session lifetime remaining"
                >
                  <span className="material-symbols-outlined text-[12px]">timer</span>
                  <span>{formatTimeRemaining(timeRemainingSeconds)}</span>
                </div>
              )}

              {/* Refresh Frame */}
              <button
                onClick={handleRefresh}
                disabled={isActionInProgress}
                className="hover:text-white p-1 rounded hover:bg-slate-800 transition-colors disabled:opacity-50"
                title="Reload Preview Frame"
                data-testid="preview-refresh-btn"
              >
                <span className="material-symbols-outlined text-[15px]">refresh</span>
              </button>

              {/* Viewport: Mobile */}
              <button
                onClick={() => setViewportMode('mobile')}
                className={`p-1 rounded transition-colors ${
                  viewportMode === 'mobile'
                    ? 'text-blue-400 bg-slate-800'
                    : 'hover:text-white hover:bg-slate-800'
                }`}
                title="Mobile Viewport (375px)"
                data-testid="viewport-mobile-btn"
              >
                <span className="material-symbols-outlined text-[15px]">smartphone</span>
              </button>

              {/* Viewport: Desktop */}
              <button
                onClick={() => setViewportMode('desktop')}
                className={`p-1 rounded transition-colors ${
                  viewportMode === 'desktop'
                    ? 'text-blue-400 bg-slate-800'
                    : 'hover:text-white hover:bg-slate-800'
                }`}
                title="Responsive Desktop Viewport"
                data-testid="viewport-desktop-btn"
              >
                <span className="material-symbols-outlined text-[15px]">laptop</span>
              </button>

              {/* Open in New Tab */}
              <button
                onClick={handleOpenInNewTab}
                className="hover:text-white p-1 rounded hover:bg-slate-800 transition-colors"
                title="Open Preview in New Tab"
                data-testid="preview-newtab-btn"
              >
                <span className="material-symbols-outlined text-[15px]">open_in_new</span>
              </button>

              {/* Stop Preview */}
              <button
                onClick={() => handleStop()}
                disabled={isActionInProgress}
                className="hover:text-red-400 p-1 rounded hover:bg-slate-800 transition-colors disabled:opacity-50"
                title="Stop Preview Environment"
                data-testid="preview-stop-btn"
              >
                <span className="material-symbols-outlined text-[15px]">stop_circle</span>
              </button>
            </>
          )}

          {/* Close Panel Button */}
          {typeof onClose === 'function' && (
            <button
              onClick={onClose}
              className="hover:text-white p-1 rounded hover:bg-slate-800 transition-colors"
              title="Close Preview Panel"
            >
              <span className="material-symbols-outlined text-[15px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* Preview Main Body Container */}
      <div className="flex-1 bg-[#05070D] flex flex-col relative overflow-hidden">
        {/* ========================================================
            STATE 1: IDLE — Ready to Run
            ======================================================== */}
        {(status === 'IDLE' || !status) && (
          <div
            className="flex-1 flex flex-col items-center justify-center p-6 text-center"
            data-testid="preview-idle-state"
          >
            <div className="w-14 h-14 rounded-2xl bg-blue-600/10 border border-blue-500/20 text-blue-400 flex items-center justify-center mb-4 shadow-lg shadow-blue-500/5">
              <span className="material-symbols-outlined text-[32px]">rocket_launch</span>
            </div>
            <h3 className="font-headline text-base font-bold text-white">
              Live Isolated Preview
            </h3>
            <p className="text-xs text-slate-400 mt-1.5 max-w-sm leading-relaxed">
              Launch this repository in an isolated cloud container with dedicated reverse-proxy
              framing, live HMR, and partitioned security cookies.
            </p>

            {/* Supported Frameworks List */}
            <div className="flex flex-wrap items-center justify-center gap-1.5 mt-4">
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-border-subtle text-slate-300">
                HTML / CSS / JS (Static)
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-border-subtle text-slate-300">
                Vite Vanilla
              </span>
              <span className="px-2 py-0.5 rounded text-[10px] font-mono bg-slate-900 border border-border-subtle text-slate-300">
                Vite React + JSX
              </span>
            </div>

            {/* Run Preview CTA */}
            <button
              onClick={() => handleStart()}
              disabled={isActionInProgress}
              className="mt-6 px-5 py-2.5 bg-blue-600 hover:bg-blue-500 active:scale-95 text-white font-medium text-xs font-mono rounded-lg transition-all shadow-lg shadow-blue-600/20 flex items-center gap-2 disabled:opacity-50"
              data-testid="preview-run-btn"
            >
              <span className="material-symbols-outlined text-[16px]">play_arrow</span>
              <span>Run Preview</span>
            </button>

            {/* Hardened Security Guarantees */}
            <div className="mt-8 pt-6 border-t border-border-subtle w-full max-w-xs text-left space-y-2">
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                <span className="material-symbols-outlined text-[14px] text-emerald-400">
                  verified_user
                </span>
                <span>Loopback runner isolation</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                <span className="material-symbols-outlined text-[14px] text-emerald-400">
                  cookie
                </span>
                <span>__Host- partitioned cookies (CHIPS)</span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-400 font-mono">
                <span className="material-symbols-outlined text-[14px] text-emerald-400">
                  security
                </span>
                <span>Strict Content-Security-Policy</span>
              </div>
            </div>
          </div>
        )}

        {/* ========================================================
            STATE 2: PROGRESSIVE LOADING (PENDING, FETCHING, BUILDING, STARTING)
            ======================================================== */}
        {(status === PreviewStatus.PENDING ||
          status === PreviewStatus.FETCHING ||
          status === PreviewStatus.BUILDING ||
          status === PreviewStatus.STARTING) && (
          <div
            className="flex-1 flex flex-col items-center justify-center p-8 text-center"
            data-testid="preview-loading-state"
          >
            <div className="relative mb-5">
              <div className="w-12 h-12 rounded-full border-2 border-blue-500/20 border-t-blue-400 animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center text-blue-400">
                <span className="material-symbols-outlined text-[18px]">cached</span>
              </div>
            </div>

            <h3
              className="font-headline text-sm font-semibold text-white"
              data-testid="preview-stage-title"
            >
              {getStageTitle()}
            </h3>

            {/* Stepper Indicator */}
            <div className="w-full max-w-xs mt-4 space-y-2">
              <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                <span
                  className={
                    status === PreviewStatus.FETCHING ||
                    status === PreviewStatus.BUILDING ||
                    status === PreviewStatus.STARTING
                      ? 'text-blue-400 font-bold'
                      : 'text-slate-500'
                  }
                >
                  1. Fetch
                </span>
                <span
                  className={
                    status === PreviewStatus.BUILDING || status === PreviewStatus.STARTING
                      ? 'text-blue-400 font-bold'
                      : 'text-slate-500'
                  }
                >
                  2. Build
                </span>
                <span
                  className={
                    status === PreviewStatus.STARTING
                      ? 'text-blue-400 font-bold'
                      : 'text-slate-500'
                  }
                >
                  3. Launch
                </span>
              </div>

              <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden border border-border-subtle">
                <div
                  className="h-full bg-gradient-to-r from-blue-600 to-indigo-500 transition-all duration-500"
                  style={{
                    width:
                      status === PreviewStatus.FETCHING
                        ? '33%'
                        : status === PreviewStatus.BUILDING
                        ? '66%'
                        : status === PreviewStatus.STARTING
                        ? '90%'
                        : '10%',
                  }}
                />
              </div>
            </div>

            <p className="text-[11px] font-mono text-slate-500 mt-3 max-w-xs">
              Provisioning non-root UID 10001 container with read-only rootfs and single-use
              bootstrap token.
            </p>

            {/* Cancel Button */}
            <button
              onClick={() => handleStop()}
              className="mt-6 px-3.5 py-1.5 rounded bg-dark-surface-container hover:bg-slate-800 border border-border-subtle text-slate-300 hover:text-white text-xs font-mono transition-colors"
              data-testid="preview-cancel-btn"
            >
              Cancel Launch
            </button>
          </div>
        )}

        {/* ========================================================
            STATE 3: RUNNING — Active Iframe
            ======================================================== */}
        {status === PreviewStatus.RUNNING && (
          <div
            className="flex-1 flex flex-col relative w-full h-full overflow-hidden"
            data-testid="preview-running-state"
          >
            {/* Viewport Sizing Wrapper */}
            <div
              data-testid="preview-viewport-container"
              className={`flex-1 flex flex-col h-full mx-auto transition-all duration-300 ${
                viewportMode === 'mobile'
                  ? 'w-[375px] max-w-full my-4 border border-border-strong rounded-2xl overflow-hidden shadow-2xl bg-black'
                  : 'w-full'
              }`}
            >
              {/* Iframe Loading Overlay */}
              {isIframeLoading && (
                <div className="absolute inset-0 bg-[#070A10]/80 backdrop-blur-xs flex flex-col items-center justify-center z-10 text-center">
                  <div className="w-8 h-8 rounded-full border-2 border-accent border-t-transparent animate-spin mb-2" />
                  <span className="text-xs font-mono text-slate-300">
                    Redeeming single-use bootstrap ticket...
                  </span>
                </div>
              )}

              {/* Secure Sandboxed Iframe */}
              {iframeUrl ? (
                <iframe
                  src={iframeUrl}
                  title={repoName}
                  sandbox="allow-scripts allow-forms allow-same-origin"
                  referrerPolicy="no-referrer"
                  onLoad={() => setIsIframeLoading(false)}
                  className="w-full h-full border-0 bg-white"
                  data-testid="preview-iframe"
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-slate-500 text-xs font-mono">
                  Loading ticket bootstrap...
                </div>
              )}
            </div>
          </div>
        )}

        {/* ========================================================
            STATE 4: STOPPED
            ======================================================== */}
        {status === PreviewStatus.STOPPED && (
          <div
            className="flex-1 flex flex-col items-center justify-center p-6 text-center"
            data-testid="preview-stopped-state"
          >
            <div className="w-12 h-12 rounded-full bg-slate-800/80 border border-border-subtle text-slate-400 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[26px]">stop</span>
            </div>
            <h3 className="font-headline text-base font-semibold text-white">
              Preview Session Stopped
            </h3>
            <p className="text-xs text-slate-400 mt-1.5 max-w-xs">
              All Docker containers, proxy sockets, and ephemeral volumes have been safely released.
            </p>
            <button
              onClick={handleRestart}
              disabled={isActionInProgress}
              className="mt-5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs font-mono rounded-lg transition-colors flex items-center gap-1.5 shadow"
              data-testid="preview-restart-btn"
            >
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>
              <span>Restart Preview</span>
            </button>
          </div>
        )}

        {/* ========================================================
            STATE 5: FAILED
            ======================================================== */}
        {status === PreviewStatus.FAILED && (
          <div
            className="flex-1 flex flex-col items-center justify-center p-6 text-center overflow-y-auto"
            data-testid="preview-failed-state"
          >
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[28px]">error</span>
            </div>
            <h3 className="font-headline text-base font-bold text-white">
              Preview Execution Failed
            </h3>
            <p className="text-xs text-slate-300 mt-1 max-w-xs">
              {errorInfo?.message || session?.errorMessage || 'An error occurred during build or launch.'}
            </p>

            {/* Error Code Pill */}
            {(errorInfo?.code || session?.errorCode) && (
              <div
                className="mt-3 px-2.5 py-1 rounded bg-red-950/60 border border-red-500/30 text-red-300 text-[11px] font-mono"
                data-testid="preview-error-code"
              >
                Code: {errorInfo?.code || session?.errorCode}
              </div>
            )}

            {/* Collapsible Error Details */}
            {session?.errorMessage && (
              <div className="w-full max-w-sm mt-3 text-left">
                <button
                  onClick={() => setShowErrorDetails(!showErrorDetails)}
                  className="text-[11px] font-mono text-slate-400 hover:text-white flex items-center gap-1 mx-auto"
                >
                  <span>{showErrorDetails ? 'Hide Details' : 'Show Error Log'}</span>
                  <span className="material-symbols-outlined text-[13px]">
                    {showErrorDetails ? 'expand_less' : 'expand_more'}
                  </span>
                </button>

                {showErrorDetails && (
                  <pre className="mt-2 p-3 rounded bg-black/60 border border-border-subtle text-[10px] font-mono text-red-300 overflow-x-auto max-h-40 whitespace-pre-wrap">
                    {session.errorMessage}
                  </pre>
                )}
              </div>
            )}

            {/* Retry Button */}
            <button
              onClick={() => handleStart()}
              disabled={isActionInProgress}
              className="mt-5 px-4 py-2 bg-dark-surface-container hover:bg-slate-800 border border-border-subtle text-white font-mono text-xs rounded-lg transition-colors flex items-center gap-1.5"
              data-testid="preview-retry-btn"
            >
              <span className="material-symbols-outlined text-[15px]">replay</span>
              <span>Try Again</span>
            </button>
          </div>
        )}

        {/* ========================================================
            STATE 6: EXPIRED
            ======================================================== */}
        {status === PreviewStatus.EXPIRED && (
          <div
            className="flex-1 flex flex-col items-center justify-center p-6 text-center"
            data-testid="preview-expired-state"
          >
            <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[26px]">timer_off</span>
            </div>
            <h3 className="font-headline text-base font-bold text-white">
              Preview Session Expired
            </h3>
            <p className="text-xs text-slate-400 mt-1 max-w-xs">
              Live preview sessions have a 1-hour maximum runtime to protect shared sandbox
              resources.
            </p>
            <button
              onClick={() => handleStart()}
              disabled={isActionInProgress}
              className="mt-5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium text-xs font-mono rounded-lg transition-colors flex items-center gap-1.5 shadow"
              data-testid="preview-relaunch-btn"
            >
              <span className="material-symbols-outlined text-[16px]">restart_alt</span>
              <span>Start New Session</span>
            </button>
          </div>
        )}

        {/* ========================================================
            STATE 7: CONFLICT (Concurrent session limit)
            ======================================================== */}
        {status === 'CONFLICT' && (
          <div
            className="flex-1 flex flex-col items-center justify-center p-6 text-center"
            data-testid="preview-conflict-state"
          >
            <div className="w-12 h-12 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-[26px]">tab_close</span>
            </div>
            <h3 className="font-headline text-base font-bold text-white">
              Active Preview Exists
            </h3>
            <p className="text-xs text-slate-300 mt-1 max-w-xs">
              Each user is limited to 1 active preview session at a time. A preview is currently
              running in another workspace or tab.
            </p>
            <div className="mt-5 flex flex-col sm:flex-row items-center gap-2">
              <button
                onClick={handleTerminateAndRestart}
                disabled={isActionInProgress}
                className="w-full sm:w-auto px-4 py-2 bg-amber-600 hover:bg-amber-500 text-white font-medium text-xs font-mono rounded-lg transition-colors flex items-center justify-center gap-1.5 shadow"
                data-testid="preview-terminate-restart-btn"
              >
                <span className="material-symbols-outlined text-[15px]">swap_horiz</span>
                <span>Switch to This Preview</span>
              </button>
              <button
                onClick={() => setStatus('IDLE')}
                className="w-full sm:w-auto px-3.5 py-2 rounded bg-dark-surface-container hover:bg-slate-800 border border-border-subtle text-slate-300 text-xs font-mono transition-colors"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Footer Info Bar */}
      <div className="p-2 border-t border-border-subtle bg-[#080B12] flex items-center justify-between text-[10px] font-mono text-slate-400 shrink-0 select-none">
        <div className="flex items-center gap-1.5">
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              status === PreviewStatus.RUNNING
                ? 'bg-emerald-400 animate-pulse'
                : status === PreviewStatus.FAILED
                ? 'bg-red-400'
                : status === PreviewStatus.STOPPED
                ? 'bg-slate-500'
                : 'bg-amber-400'
            }`}
          />
          <span className="capitalize">{status ? status.toLowerCase() : 'idle'}</span>
        </div>
        <div className="text-slate-500">
          GitView Preview Engine v1.2
        </div>
      </div>
    </aside>
  );
};

export default LivePreview;
