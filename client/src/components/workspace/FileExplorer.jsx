import React, { useState } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';

export const FileExplorer = ({ width = 256 }) => {
  const { activeTab, selectFile } = useWorkspace();
  const [filterText, setFilterText] = useState('');
  const [openFolders, setOpenFolders] = useState({
    'apps/www': true,
    'registry': true,
    'lib': false
  });

  const toggleFolder = (folderKey) => {
    setOpenFolders((prev) => ({
      ...prev,
      [folderKey]: !prev[folderKey]
    }));
  };

  const collapseAll = () => {
    setOpenFolders({
      'apps/www': false,
      'registry': false,
      'lib': false
    });
  };

  const expandAll = () => {
    setOpenFolders({
      'apps/www': true,
      'registry': true,
      'lib': true
    });
  };

  const getFileBadge = (filename) => {
    if (filename.endsWith('.tsx') || filename.endsWith('.ts')) {
      return <span className="text-[10px] font-bold text-blue-400">TS</span>;
    }
    if (filename.endsWith('.json')) {
      return <span className="text-[10px] font-bold text-red-400">{`{}`}</span>;
    }
    if (filename.endsWith('.md')) {
      return <span className="material-symbols-outlined text-[14px] text-blue-400">description</span>;
    }
    return <span className="text-[10px] font-bold text-amber-400">JS</span>;
  };

  const files = [
    { name: 'button.tsx', path: 'button.tsx', parent: 'registry' },
    { name: 'dialog.tsx', path: 'dialog.tsx', parent: 'registry' },
    { name: 'dropdown-menu.tsx', path: 'dropdown-menu.tsx', parent: 'registry' },
    { name: 'tabs.tsx', path: 'tabs.tsx', parent: 'registry' },
    { name: 'utils.ts', path: 'utils.ts', parent: 'lib' },
    { name: 'tailwind.config.ts', path: 'tailwind.config.ts', parent: null },
    { name: 'package.json', path: 'package.json', parent: null },
    { name: 'README.md', path: 'README.md', parent: null },
    { name: 'tsconfig.json', path: 'tsconfig.json', parent: null },
    { name: 'components.json', path: 'components.json', parent: null }
  ];

  const matchesFilter = (filename) => {
    if (!filterText) return true;
    return filename.toLowerCase().includes(filterText.toLowerCase());
  };

  return (
    <aside
      className="bg-[#080C14] flex flex-col shrink-0 select-none overflow-hidden h-full border-r border-border-subtle"
      style={{ width: `${width}px`, minWidth: '180px', maxWidth: '420px' }}
    >
      {/* Explorer Titlebar */}
      <div className="h-9 px-3 border-b border-border-subtle flex items-center justify-between bg-[#070A10]">
        <div className="flex items-center gap-2 text-[11px] font-mono font-semibold tracking-wider text-slate-400 uppercase">
          <span className="material-symbols-outlined text-[15px] text-slate-500">folder_open</span>
          <span>Explorer</span>
        </div>
        <div className="flex items-center gap-1 text-slate-400">
          <button
            onClick={collapseAll}
            className="hover:text-white p-0.5"
            title="Collapse All Folders"
          >
            <span className="material-symbols-outlined text-[14px]">unfold_less</span>
          </button>
          <button
            onClick={expandAll}
            className="hover:text-white p-0.5"
            title="Expand All Folders"
          >
            <span className="material-symbols-outlined text-[14px]">unfold_more</span>
          </button>
        </div>
      </div>

      {/* Quick Fuzzy File Filter Input */}
      <div className="p-2 border-b border-border-subtle bg-[#080C14]">
        <div className="relative flex items-center">
          <span className="material-symbols-outlined absolute left-2 text-slate-500 text-[13px]">
            search
          </span>
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Search files (⌘P)"
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

      {/* File Tree Node List */}
      <div className="flex-1 overflow-y-auto p-1.5 text-xs font-mono space-y-0.5">
        {/* Folder 1: apps/www */}
        <div>
          <div
            onClick={() => toggleFolder('apps/www')}
            className="flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-dark-surface-container text-slate-300 cursor-pointer"
          >
            <span className="material-symbols-outlined text-[14px] text-slate-500">
              {openFolders['apps/www'] ? 'expand_more' : 'chevron_right'}
            </span>
            <span className="material-symbols-outlined text-[15px] text-amber-400">
              {openFolders['apps/www'] ? 'folder_open' : 'folder'}
            </span>
            <span>apps/www</span>
          </div>

          {openFolders['apps/www'] && (
            <div className="pl-3.5 space-y-0.5 border-l border-border-subtle/50 ml-2">
              {/* Subfolder: registry */}
              <div
                onClick={() => toggleFolder('registry')}
                className="flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-dark-surface-container text-slate-300 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px] text-slate-500">
                  {openFolders['registry'] ? 'expand_more' : 'chevron_right'}
                </span>
                <span className="material-symbols-outlined text-[15px] text-amber-400">
                  {openFolders['registry'] ? 'folder_open' : 'folder'}
                </span>
                <span>registry</span>
              </div>

              {openFolders['registry'] && (
                <div className="pl-3.5 space-y-0.5 border-l border-border-subtle/50 ml-2">
                  {files
                    .filter((f) => f.parent === 'registry' && matchesFilter(f.name))
                    .map((file) => {
                      const isActive = activeTab === file.name;
                      return (
                        <div
                          key={file.name}
                          onClick={() => selectFile(file.name)}
                          className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer transition-colors ${
                            isActive
                              ? 'bg-dark-surface-container text-blue-300 border border-blue-500/30 font-medium'
                              : 'text-slate-400 hover:text-slate-200 hover:bg-dark-surface-container/60'
                          }`}
                        >
                          {getFileBadge(file.name)}
                          <span className="truncate">{file.name}</span>
                        </div>
                      );
                    })}
                </div>
              )}

              {/* Subfolder: lib */}
              <div
                onClick={() => toggleFolder('lib')}
                className="flex items-center gap-1.5 py-1 px-1.5 rounded hover:bg-dark-surface-container text-slate-300 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[14px] text-slate-500">
                  {openFolders['lib'] ? 'expand_more' : 'chevron_right'}
                </span>
                <span className="material-symbols-outlined text-[15px] text-amber-400">
                  {openFolders['lib'] ? 'folder_open' : 'folder'}
                </span>
                <span>lib</span>
              </div>

              {openFolders['lib'] && (
                <div className="pl-3.5 space-y-0.5 border-l border-border-subtle/50 ml-2">
                  {files
                    .filter((f) => f.parent === 'lib' && matchesFilter(f.name))
                    .map((file) => {
                      const isActive = activeTab === file.name;
                      return (
                        <div
                          key={file.name}
                          onClick={() => selectFile(file.name)}
                          className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer transition-colors ${
                            isActive
                              ? 'bg-dark-surface-container text-blue-300 border border-blue-500/30 font-medium'
                              : 'text-slate-400 hover:text-slate-200 hover:bg-dark-surface-container/60'
                          }`}
                        >
                          {getFileBadge(file.name)}
                          <span className="truncate">{file.name}</span>
                        </div>
                      );
                    })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Root Files */}
        {files
          .filter((f) => f.parent === null && matchesFilter(f.name))
          .map((file) => {
            const isActive = activeTab === file.name;
            return (
              <div
                key={file.name}
                onClick={() => selectFile(file.name)}
                className={`flex items-center gap-2 py-1 px-2 rounded cursor-pointer transition-colors ${
                  isActive
                    ? 'bg-dark-surface-container text-blue-300 border border-blue-500/30 font-medium'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-dark-surface-container/60'
                }`}
              >
                {getFileBadge(file.name)}
                <span className="truncate">{file.name}</span>
              </div>
            );
          })}
      </div>

      {/* File Explorer Footer */}
      <div className="h-6 px-3 border-t border-border-subtle bg-[#05080E] text-[10px] font-mono text-slate-500 flex items-center justify-between shrink-0">
        <span>Git: clean</span>
        <span>48 files</span>
      </div>
    </aside>
  );
};
