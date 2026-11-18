import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useWorkspace } from '../context/WorkspaceContext';
import { WorkspaceToolbar } from '../components/workspace/WorkspaceToolbar';
import { FileExplorer } from '../components/workspace/FileExplorer';
import { MonacoEditor } from '../components/workspace/MonacoEditor';
import { ReadmeViewer } from '../components/workspace/ReadmeViewer';
import { DependenciesViewer } from '../components/workspace/DependenciesViewer';
import { LivePreview } from '../components/workspace/LivePreview';
import { CommandPaletteModal, Modal } from '../components/common/Modal';
import { repoService } from '../services/repoService';
import { mockRepositories } from '../data/mockRepositories';

export const WorkspacePage = () => {
  const { repoId } = useParams();
  const [searchParams] = useSearchParams();
  const {
    currentRepo,
    setCurrentRepo,
    mainViewMode,
    isPreviewOpen,
    selectFile,
    triggerSandboxRefresh,
    treeCache,
  } = useWorkspace();

  const [leftWidth, setLeftWidth] = useState(256);
  const [rightWidth, setRightWidth] = useState(480);
  const [isResizingLeft, setIsResizingLeft] = useState(false);
  const [isResizingRight, setIsResizingRight] = useState(false);
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [isResetModalOpen, setIsResetModalOpen] = useState(false);

  // Sync real repository if passed in URL params or route
  useEffect(() => {
    const targetIdentifier = repoId || searchParams.get('repo') || searchParams.get('id');

    async function resolveRepository() {
      if (targetIdentifier) {
        try {
          const repo = await repoService.getRepositoryById(targetIdentifier);
          if (repo) {
            setCurrentRepo(repo);
            return;
          }
        } catch {
          // Continue to list match or mock fallback
        }
      }

      // Try user's imported repositories
      try {
        const userRepos = await repoService.getRepositories();
        if (Array.isArray(userRepos) && userRepos.length > 0) {
          if (targetIdentifier) {
            const match = userRepos.find(
              (r) => r.id === targetIdentifier || r.fullName === targetIdentifier || targetIdentifier.includes(r.name)
            );
            if (match) {
              setCurrentRepo(match);
              return;
            }
          }
          setCurrentRepo(userRepos[0]);
          return;
        }
      } catch {
        // Fallback to mock
      }

      // Fallback for preset preview repos
      const match = mockRepositories.find((r) => r.id === targetIdentifier || r.fullName === targetIdentifier);
      setCurrentRepo(match || mockRepositories[0]);
    }

    resolveRepository();
  }, [repoId, searchParams, setCurrentRepo]);

  // Global Keyboard shortcuts (⌘K for command palette, ⌘P for search)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setIsCommandPaletteOpen((prev) => !prev);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        triggerSandboxRefresh();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [triggerSandboxRefresh]);

  // Resizing logic
  const handleMouseMove = useCallback(
    (e) => {
      if (isResizingLeft) {
        const newWidth = Math.max(180, Math.min(e.clientX, 450));
        setLeftWidth(newWidth);
      }
      if (isResizingRight) {
        const newWidth = Math.max(280, Math.min(window.innerWidth - e.clientX, 800));
        setRightWidth(newWidth);
      }
    },
    [isResizingLeft, isResizingRight]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizingLeft(false);
    setIsResizingRight(false);
    document.body.style.cursor = '';
  }, []);

  useEffect(() => {
    if (isResizingLeft || isResizingRight) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizingLeft, isResizingRight, handleMouseMove, handleMouseUp]);

  const cachedFiles = Object.values(treeCache || {})
    .flat()
    .filter((e) => e && e.type === 'file')
    .map((e) => e.path);
  const allFilesList = cachedFiles.length > 0 ? cachedFiles : [
    'package.json',
    'README.md',
    'tsconfig.json',
  ];

  return (
    <div className="min-h-screen bg-[#070A10] text-dark-on-surface font-body antialiased flex flex-col h-screen overflow-hidden selection:bg-accent/30 selection:text-white">
      {/* Top Navigation Toolbar */}
      <WorkspaceToolbar
        onOpenCommandPalette={() => setIsCommandPaletteOpen(true)}
      />

      {/* 3-Pane IDE Container */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* PANE 1: Left File Explorer */}
        <FileExplorer width={leftWidth} />

        {/* Resizer Divider 1 (Left to Center) */}
        <div
          onMouseDown={(e) => {
            e.preventDefault();
            setIsResizingLeft(true);
          }}
          className={`resizer-v bg-border-subtle hover:bg-dark-primary ${
            isResizingLeft ? 'resizing bg-dark-primary' : ''
          }`}
          title="Drag to resize file explorer"
        />

        {/* PANE 2: Center Viewport (Monaco Code Viewer / README / Dependencies) */}
        <main className="flex-1 flex flex-col bg-[#070A12] overflow-hidden min-w-[280px]">
          {mainViewMode === 'readme' ? (
            <ReadmeViewer />
          ) : mainViewMode === 'deps' ? (
            <DependenciesViewer />
          ) : (
            <MonacoEditor />
          )}
        </main>

        {/* Resizer Divider 2 (Center to Right) */}
        {isPreviewOpen && (
          <>
            <div
              onMouseDown={(e) => {
                e.preventDefault();
                setIsResizingRight(true);
              }}
              className={`resizer-v bg-border-subtle hover:bg-dark-primary ${
                isResizingRight ? 'resizing bg-dark-primary' : ''
              }`}
              title="Drag to resize live preview"
            />

            {/* PANE 3: Right Live Preview Panel */}
            <LivePreview width={rightWidth} />
          </>
        )}
      </div>

      {/* Command Palette Modal (⌘K) */}
      <CommandPaletteModal
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        files={allFilesList}
        onSelectFile={(path) => {
          selectFile(path);
        }}
        onSelectAction={(act) => {
          if (act === 'restart') {
            triggerSandboxRefresh();
          }
        }}
      />

      {/* Reset Container Confirmation Modal */}
      <Modal
        isOpen={isResetModalOpen}
        onClose={() => setIsResetModalOpen(false)}
        maxWidth="max-w-md"
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-red-500/10 border border-red-500/20 text-red-400 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-[20px]">warning</span>
            </div>
            <div>
              <h3 className="font-headline text-headline-sm font-semibold text-white">
                Reset Sandbox Container?
              </h3>
              <p className="text-body-sm text-slate-400 mt-1">
                This will terminate running Node.js processes, wipe in-memory virtual filesystem changes, and reinstall packages from package.json.
              </p>
            </div>
          </div>

          <div className="pt-3 border-t border-border-subtle flex items-center justify-end gap-3 font-label text-xs">
            <button
              onClick={() => setIsResetModalOpen(false)}
              className="px-4 py-2 rounded bg-dark-surface-container hover:bg-slate-800 text-slate-300 border border-border-subtle transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => {
                setIsResetModalOpen(false);
                triggerSandboxRefresh();
              }}
              className="px-4 py-2 rounded bg-danger hover:bg-red-600 text-white font-medium transition-colors shadow"
            >
              Reset Container
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
