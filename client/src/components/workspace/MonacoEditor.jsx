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
    loadingFile,
    currentBranch
  } = useWorkspace();

  const [copied, setCopied] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 18, col: 12 });

  const getLanguage = (fileName) => {
    if (fileName.endsWith('.tsx')) return 'typescript';
    if (fileName.endsWith('.ts')) return 'typescript';
    if (fileName.endsWith('.json')) return 'json';
    if (fileName.endsWith('.md')) return 'markdown';
    if (fileName.endsWith('.css')) return 'css';
    return 'javascript';
  };

  const getLanguageLabel = (fileName) => {
    if (fileName.endsWith('.tsx')) return 'TypeScript JSX';
    if (fileName.endsWith('.ts')) return 'TypeScript';
    if (fileName.endsWith('.json')) return 'JSON';
    if (fileName.endsWith('.md')) return 'Markdown';
    return 'JavaScript';
  };

  const getTabIcon = (fileName) => {
    if (fileName.endsWith('.json')) {
      return <span className="text-[10px] font-bold text-red-400">{`{}`}</span>;
    }
    if (fileName.endsWith('.md')) {
      return <span className="material-symbols-outlined text-[13px] text-blue-400">description</span>;
    }
    return <span className="text-[10px] font-bold text-blue-400">TS</span>;
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

  return (
    <div className="flex-1 flex flex-col bg-[#070A12] overflow-hidden min-w-[280px] h-full">
      {/* Monaco Tab Bar */}
      <div className="h-9 bg-[#090D16] border-b border-border-subtle flex items-center justify-between px-2 overflow-x-auto shrink-0 select-none">
        {/* Open File Tabs */}
        <div className="flex items-center h-full gap-0.5">
          {openTabs.map((tab) => {
            const isActive = tab === activeTab;
            return (
              <div
                key={tab}
                onClick={() => selectFile(tab)}
                className={`h-full flex items-center gap-2 px-3 font-mono text-xs cursor-pointer border-r border-border-subtle transition-colors ${
                  isActive
                    ? 'bg-[#070A12] border-t-2 border-dark-primary text-white font-medium'
                    : 'bg-transparent hover:bg-dark-surface-container/40 text-slate-400 hover:text-slate-200'
                }`}
              >
                {getTabIcon(tab)}
                <span>{tab}</span>
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

        {/* Breadcrumbs & Document Stats */}
        <div className="flex items-center gap-3 text-[11px] font-mono text-slate-500 shrink-0">
          <span className="hidden sm:inline">{getLanguageLabel(activeTab)}</span>
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
        </div>
      </div>

      {/* Breadcrumb Bar */}
      <div className="h-6 bg-[#080C14] border-b border-border-subtle/80 px-4 flex items-center gap-1.5 text-[11px] font-mono text-slate-400 shrink-0 select-none">
        <span className="text-slate-500">apps</span>
        <span className="text-slate-600">/</span>
        <span className="text-slate-500">www</span>
        <span className="text-slate-600">/</span>
        <span className="text-slate-500">registry</span>
        <span className="text-slate-600">/</span>
        <span className="text-slate-200 font-medium">{activeTab}</span>
      </div>

      {/* Code Editor Viewport */}
      <div className="flex-1 overflow-hidden relative">
        {loadingFile ? (
          <div className="flex items-center justify-center h-full">
            <span className="w-8 h-8 border-2 border-dark-primary border-t-transparent rounded-full animate-spin"></span>
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
              wordWrap: 'on'
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
            <span className="material-symbols-outlined text-[13px] text-emerald-400">check</span>
            <span>TypeScript 5.3 (0 errors)</span>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span>Ln {cursorPos.line}, Col {cursorPos.col}</span>
          <span>Spaces: 2</span>
          <span>UTF-8</span>
          <span className="text-accent flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
            WebContainer Live
          </span>
        </div>
      </footer>
    </div>
  );
};
