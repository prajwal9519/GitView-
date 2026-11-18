import React, { useState } from 'react';
import Editor from '@monaco-editor/react';
import { useWorkspace } from '../../context/WorkspaceContext';

export const MonacoEditor = () => {
  const {
    openTabs,
    activeTab,
    selectFile,
    closeTab,
    fileContent,
    fileMeta,
    fileError,
    loadingFile,
    loadFile,
    currentBranch,
  } = useWorkspace();

  const [copied, setCopied] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });

  const getLanguage = (fileName) => {
    if (!fileName) return 'plaintext';
    if (fileMeta?.language) return fileMeta.language;
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.tsx') || lower.endsWith('.ts')) return 'typescript';
    if (lower.endsWith('.jsx') || lower.endsWith('.js') || lower.endsWith('.mjs')) return 'javascript';
    if (lower.endsWith('.json')) return 'json';
    if (lower.endsWith('.md')) return 'markdown';
    if (lower.endsWith('.css') || lower.endsWith('.scss')) return 'css';
    if (lower.endsWith('.html')) return 'html';
    if (lower.endsWith('.py')) return 'python';
    if (lower.endsWith('.go')) return 'go';
    if (lower.endsWith('.rs')) return 'rust';
    if (lower.endsWith('.yaml') || lower.endsWith('.yml')) return 'yaml';
    if (lower.endsWith('.sql')) return 'sql';
    return 'plaintext';
  };

  const getLanguageLabel = (fileName) => {
    if (!fileName) return '';
    const lang = getLanguage(fileName);
    return lang.charAt(0).toUpperCase() + lang.slice(1);
  };

  const getTabIcon = (fileName) => {
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.json')) {
      return <span className="text-[10px] font-bold text-red-400">{`{}`}</span>;
    }
    if (lower.endsWith('.md')) {
      return <span className="material-symbols-outlined text-[13px] text-blue-400">description</span>;
    }
    if (lower.endsWith('.ts') || lower.endsWith('.tsx')) {
      return <span className="text-[10px] font-bold text-blue-400">TS</span>;
    }
    return <span className="text-[10px] font-bold text-amber-400">JS</span>;
  };

  const handleCopy = () => {
    if (fileContent) {
      navigator.clipboard.writeText(fileContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleEditorMount = (editor) => {
    editor.onDidChangeCursorPosition((e) => {
      setCursorPos({ line: e.position.lineNumber, col: e.position.column });
    });
  };

  const breadcrumbs = (fileMeta?.path || activeTab || '').split('/').filter(Boolean);

  return (
    <div className="flex-1 flex flex-col bg-[#070A12] overflow-hidden min-w-[280px] h-full">
      {/* Monaco Tab Bar */}
      <div className="h-9 bg-[#090D16] border-b border-border-subtle flex items-center justify-between px-2 overflow-x-auto shrink-0 select-none">
        {/* Open File Tabs */}
        <div className="flex items-center h-full gap-0.5">
          {openTabs.map((tab) => {
            const isActive = tab === activeTab;
            const tabName = tab.split('/').pop();
            return (
              <div
                key={tab}
                onClick={() => selectFile(tab)}
                className={`h-full flex items-center gap-2 px-3 font-mono text-xs cursor-pointer border-r border-border-subtle transition-colors ${
                  isActive
                    ? 'bg-[#070A12] border-t-2 border-dark-primary text-white font-medium'
                    : 'bg-transparent hover:bg-dark-surface-container/40 text-slate-400 hover:text-slate-200'
                }`}
                title={tab}
              >
                {getTabIcon(tabName)}
                <span>{tabName}</span>
                <button
                  type="button"
                  onClick={(e) => closeTab(tab, e)}
                  className="text-slate-500 hover:text-white ml-1 text-xs p-0.5 rounded hover:bg-slate-800"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500 shrink-0">
          {activeTab && <span className="hidden sm:inline">{getLanguageLabel(activeTab)}</span>}
          {fileContent && (
            <button
              onClick={handleCopy}
              className="text-slate-400 hover:text-white flex items-center gap-1 transition-colors"
              title="Copy code"
            >
              <span className="material-symbols-outlined text-[14px]">
                {copied ? 'check' : 'content_copy'}
              </span>
              <span className="hidden lg:inline">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb Bar */}
      {activeTab && (
        <div className="h-6 bg-[#080C14] border-b border-border-subtle/80 px-4 flex items-center gap-1 text-[11px] font-mono text-slate-400 shrink-0 select-none">
          {breadcrumbs.map((segment, idx) => (
            <React.Fragment key={idx}>
              {idx > 0 && <span className="text-slate-600">/</span>}
              <span className={idx === breadcrumbs.length - 1 ? 'text-slate-200 font-medium' : 'text-slate-500'}>
                {segment}
              </span>
            </React.Fragment>
          ))}
          {fileMeta?.size > 0 && (
            <span className="text-slate-600 ml-2">
              ({fileMeta.size > 1024 ? `${(fileMeta.size / 1024).toFixed(1)} KB` : `${fileMeta.size} bytes`})
            </span>
          )}
        </div>
      )}

      {/* Code Editor Viewport */}
      <div className="flex-1 overflow-hidden relative">
        {loadingFile ? (
          <div className="flex flex-col items-center justify-center h-full space-y-3">
            <span className="w-8 h-8 border-2 border-dark-primary border-t-transparent rounded-full animate-spin"></span>
            <span className="text-xs font-mono text-slate-400">Fetching file from GitHub...</span>
          </div>
        ) : fileError ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center space-y-3">
            <div className="w-12 h-12 rounded-full bg-red-950/50 border border-red-500/40 text-red-400 flex items-center justify-center">
              <span className="material-symbols-outlined text-[24px]">error</span>
            </div>
            <h3 className="font-headline font-semibold text-white text-sm">Failed to Load File</h3>
            <p className="text-xs font-mono text-slate-400 max-w-sm">{fileError}</p>
            <button
              onClick={() => loadFile(activeTab)}
              className="px-3 py-1.5 rounded bg-dark-primary hover:bg-blue-500 text-white font-mono text-xs transition-colors"
            >
              Retry
            </button>
          </div>
        ) : fileMeta?.tooLarge ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-amber-950/50 border border-amber-500/40 text-amber-400 flex items-center justify-center">
              <span className="material-symbols-outlined text-[24px]">data_alert</span>
            </div>
            <div className="space-y-1">
              <h3 className="font-headline font-semibold text-white text-sm">File Exceeds Size Limit</h3>
              <p className="text-xs text-slate-400 max-w-md">
                This file is larger than 512 KB ({Math.round((fileMeta.size || 0) / 1024)} KB) and cannot be displayed in the in-browser code viewer.
              </p>
            </div>
            {fileMeta.htmlUrl && (
              <a
                href={fileMeta.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-mono text-xs transition-colors shadow"
              >
                <span>View Raw on GitHub</span>
                <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            )}
          </div>
        ) : fileMeta?.isBinary ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center space-y-4">
            <div className="w-12 h-12 rounded-full bg-slate-800/60 border border-border-strong text-slate-400 flex items-center justify-center">
              <span className="material-symbols-outlined text-[24px]">image</span>
            </div>
            <div className="space-y-1">
              <h3 className="font-headline font-semibold text-white text-sm">Binary File Detected</h3>
              <p className="text-xs text-slate-400 max-w-md">
                Binary assets ({fileMeta.name}) cannot be rendered as text in the source code editor.
              </p>
            </div>
            {fileMeta.htmlUrl && (
              <a
                href={fileMeta.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-dark-surface-container hover:bg-slate-800 border border-border-strong text-slate-200 font-mono text-xs transition-colors"
              >
                <span>Open File on GitHub</span>
                <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            )}
          </div>
        ) : !activeTab ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-center space-y-3">
            <span className="material-symbols-outlined text-[36px] text-slate-600">code_blocks</span>
            <p className="text-xs font-mono text-slate-400">
              Select a file from the explorer on the left to inspect its source code.
            </p>
          </div>
        ) : (
          <Editor
            height="100%"
            language={getLanguage(activeTab)}
            value={fileContent}
            theme="vs-dark"
            onMount={handleEditorMount}
            options={{
              readOnly: true,
              fontSize: 13,
              fontFamily: '"Spline Sans Mono", monospace',
              lineNumbers: 'on',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              automaticLayout: true,
              padding: { top: 12, bottom: 12 },
              cursorBlinking: 'smooth',
              renderLineHighlight: 'all',
              lineHeight: 22,
              wordWrap: 'on',
            }}
          />
        )}
      </div>

      {/* Monaco Bottom Status Bar */}
      <footer className="h-6 bg-[#05070B] border-t border-border-subtle px-3 flex items-center justify-between text-[11px] font-mono text-slate-500 shrink-0 select-none">
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1 text-slate-300">
            <span className="material-symbols-outlined text-[13px] text-blue-400">account_tree</span>
            <span>{currentBranch}</span>
          </span>
          <span className="flex items-center gap-1 text-slate-400">
            <span className="material-symbols-outlined text-[13px] text-emerald-400">lock</span>
            <span>Read-only View</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
          <span>UTF-8</span>
          <span className="text-emerald-400 flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
            GitHub Synchronized
          </span>
        </div>
      </footer>
    </div>
  );
};
