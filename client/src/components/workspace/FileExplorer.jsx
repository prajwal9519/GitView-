import React, { useState } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';

export const FileExplorer = ({ width = 256 }) => {
  const {
    treeCache,
    expandedFolders,
    toggleFolder,
    loadingTree,
    treeError,
    fetchDirectory,
    activeTab,
    selectFile,
    currentRepo,
  } = useWorkspace();

  const [filterText, setFilterText] = useState('');

  const getFileBadge = (filename) => {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.tsx') || lower.endsWith('.ts')) {
      return <span className="text-[10px] font-bold text-blue-400">TS</span>;
    }
    if (lower.endsWith('.jsx') || lower.endsWith('.js') || lower.endsWith('.mjs')) {
      return <span className="text-[10px] font-bold text-amber-400">JS</span>;
    }
    if (lower.endsWith('.json')) {
      return <span className="text-[10px] font-bold text-red-400">{`{}`}</span>;
    }
    if (lower.endsWith('.md')) {
      return <span className="material-symbols-outlined text-[14px] text-blue-400">description</span>;
    }
    if (lower.endsWith('.css') || lower.endsWith('.scss')) {
      return <span className="text-[10px] font-bold text-pink-400">#</span>;
    }
    if (lower.endsWith('.py')) {
      return <span className="text-[10px] font-bold text-emerald-400">PY</span>;
    }
    if (lower.endsWith('.rs')) {
      return <span className="text-[10px] font-bold text-orange-400">RS</span>;
    }
    if (lower.endsWith('.go')) {
      return <span className="text-[10px] font-bold text-cyan-400">GO</span>;
    }
    return <span className="material-symbols-outlined text-[14px] text-slate-400">draft</span>;
  };

  const matchesFilter = (name) => {
    if (!filterText) return true;
    return name.toLowerCase().includes(filterText.toLowerCase());
  };

  // Recursive tree renderer for folders and files
  const renderTree = (dirPath = '', depth = 0) => {
    const entries = treeCache[dirPath] || [];

    return (
      <div className="space-y-0.5">
        {entries.map((entry) => {
          const isDir = entry.type === 'dir';
          const isExpanded = expandedFolders.has(entry.path);
          const isActive = activeTab === entry.path || activeTab === entry.name;

          if (filterText && !matchesFilter(entry.name) && !isDir) {
            return null;
          }

          return (
            <div key={entry.path}>
              <div
                onClick={() => {
                  if (isDir) {
                    toggleFolder(entry.path);
                  } else {
                    selectFile(entry.path);
                  }
                }}
                style={{ paddingLeft: `${12 + depth * 14}px` }}
                className={`group flex items-center justify-between py-1 pr-2 text-xs font-mono cursor-pointer transition-colors rounded select-none ${
                  isActive
                    ? 'bg-dark-primary/20 text-white font-medium border-l-2 border-dark-primary'
                    : 'text-slate-300 hover:text-white hover:bg-[#0E1422]'
                }`}
                title={entry.path}
              >
                <div className="flex items-center gap-1.5 truncate">
                  {isDir ? (
                    <>
                      <span className="material-symbols-outlined text-[14px] text-slate-500 group-hover:text-slate-300">
                        {isExpanded ? 'expand_more' : 'chevron_right'}
                      </span>
                      <span className="material-symbols-outlined text-[15px] text-blue-400">
                        {isExpanded ? 'folder_open' : 'folder'}
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="w-3.5 flex items-center justify-center">
                        {getFileBadge(entry.name)}
                      </span>
                    </>
                  )}
                  <span className="truncate">{entry.name}</span>
                </div>

                {!isDir && entry.size > 0 && (
                  <span className="text-[10px] text-slate-600 group-hover:text-slate-400 shrink-0">
                    {entry.size > 1024 ? `${Math.round(entry.size / 1024)}k` : `${entry.size}b`}
                  </span>
                )}
              </div>

              {/* Render Children if Folder is Expanded */}
              {isDir && isExpanded && (
                <div>
                  {treeCache[entry.path] ? (
                    renderTree(entry.path, depth + 1)
                  ) : (
                    <div
                      style={{ paddingLeft: `${28 + depth * 14}px` }}
                      className="py-1 text-[11px] font-mono text-slate-500 flex items-center gap-1.5"
                    >
                      <span className="w-2.5 h-2.5 border border-dark-primary border-t-transparent rounded-full animate-spin"></span>
                      <span>Loading folder...</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <aside
      className="bg-[#080C14] flex flex-col shrink-0 select-none overflow-hidden h-full border-r border-border-subtle"
      style={{ width: `${width}px`, minWidth: '180px', maxWidth: '420px' }}
    >
      {/* Explorer Titlebar */}
      <div className="h-9 px-3 border-b border-border-subtle flex items-center justify-between bg-[#070A10]">
        <div className="flex items-center gap-2 text-[11px] font-mono font-semibold tracking-wider text-slate-400 uppercase truncate">
          <span className="material-symbols-outlined text-[15px] text-slate-500">folder_open</span>
          <span className="truncate">{currentRepo?.name || 'Explorer'}</span>
        </div>
        <div className="flex items-center gap-1 text-slate-400 shrink-0">
          <button
            onClick={() => fetchDirectory('', true)}
            className="hover:text-white p-0.5"
            title="Refresh Directory Tree"
          >
            <span className="material-symbols-outlined text-[14px]">refresh</span>
          </button>
        </div>
      </div>

      {/* Quick File Filter Input */}
      <div className="p-2 border-b border-border-subtle bg-[#080C14]">
        <div className="relative flex items-center">
          <span className="material-symbols-outlined absolute left-2 text-slate-500 text-[13px]">
            search
          </span>
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search files..."
            className="w-full bg-[#05080E] border border-border-subtle text-[11px] font-mono text-white pl-6 pr-2 py-1 rounded placeholder:text-slate-600 focus:outline-none focus:border-dark-primary transition-colors"
          />
          {filterText && (
            <button
              onClick={() => setFilterText('')}
              className="absolute right-1.5 text-slate-500 hover:text-white"
            >
              <span className="material-symbols-outlined text-[12px]">close</span>
            </button>
          )}
        </div>
      </div>

      {/* File Tree Viewport */}
      <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
        {loadingTree && !treeCache[''] ? (
          <div className="p-4 space-y-2">
            {[1, 2, 3, 4, 5].map((n) => (
              <div key={n} className="h-4 bg-slate-800/40 rounded animate-pulse w-3/4"></div>
            ))}
          </div>
        ) : treeError ? (
          <div className="p-3 text-xs font-mono text-red-400 space-y-2">
            <p className="flex items-center gap-1">
              <span className="material-symbols-outlined text-[16px]">error</span>
              <span>{treeError}</span>
            </p>
            <button
              onClick={() => fetchDirectory('', true)}
              className="px-2 py-1 rounded bg-red-950/60 hover:bg-red-900/60 text-white text-[11px]"
            >
              Retry
            </button>
          </div>
        ) : (
          renderTree('')
        )}
      </div>
    </aside>
  );
};
