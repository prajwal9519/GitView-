import React, { useEffect } from 'react';
import { useWorkspace } from '../../context/WorkspaceContext';

/**
 * Parses markdown into safe React elements without using dangerouslySetInnerHTML.
 */
function renderSafeMarkdown(markdown) {
  if (!markdown) return null;

  const lines = markdown.split('\n');
  const elements = [];
  let inCodeBlock = false;
  let codeBlockContent = [];
  let codeBlockLang = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Code block open/close
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // Close code block
        elements.push(
          <div key={`code-${i}`} className="my-4 rounded-lg bg-[#090D16] border border-border-subtle overflow-hidden">
            {codeBlockLang && (
              <div className="px-3 py-1 bg-[#05080E] border-b border-border-subtle text-[11px] font-mono text-slate-500">
                {codeBlockLang}
              </div>
            )}
            <pre className="p-4 text-xs font-mono text-slate-200 overflow-x-auto leading-relaxed">
              <code>{codeBlockContent.join('\n')}</code>
            </pre>
          </div>
        );
        codeBlockContent = [];
        codeBlockLang = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeBlockLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCodeBlock) {
      codeBlockContent.push(line);
      continue;
    }

    // Headings
    if (line.startsWith('# ')) {
      elements.push(
        <h1 key={`h1-${i}`} className="font-headline text-display-md text-white font-bold mt-6 mb-3 border-b border-border-subtle pb-2">
          {line.slice(2).trim()}
        </h1>
      );
      continue;
    }
    if (line.startsWith('## ')) {
      elements.push(
        <h2 key={`h2-${i}`} className="font-headline text-headline-lg text-white font-semibold mt-5 mb-2 border-b border-border-subtle/50 pb-1">
          {line.slice(3).trim()}
        </h2>
      );
      continue;
    }
    if (line.startsWith('### ')) {
      elements.push(
        <h3 key={`h3-${i}`} className="font-headline text-headline-sm text-slate-200 font-semibold mt-4 mb-2">
          {line.slice(4).trim()}
        </h3>
      );
      continue;
    }

    // Bullet list items
    if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
      const text = line.trim().slice(2);
      elements.push(
        <li key={`li-${i}`} className="text-body-sm text-slate-300 ml-4 list-disc space-y-1">
          {text}
        </li>
      );
      continue;
    }

    // Empty lines
    if (!line.trim()) {
      continue;
    }

    // Paragraphs
    elements.push(
      <p key={`p-${i}`} className="text-body-sm text-slate-300 leading-relaxed my-2">
        {line}
      </p>
    );
  }

  return elements;
}

export const ReadmeViewer = () => {
  const {
    currentRepo,
    readmeContent,
    readmeMeta,
    loadingReadme,
    readmeError,
    loadReadme,
    setMainViewMode,
  } = useWorkspace();

  useEffect(() => {
    if (!readmeContent && !loadingReadme && !readmeError) {
      loadReadme();
    }
  }, [readmeContent, loadingReadme, readmeError, loadReadme]);

  return (
    <div className="flex-1 overflow-y-auto p-8 max-w-4xl mx-auto space-y-6 font-body text-slate-300 w-full">
      {/* Repository Header */}
      <div className="border-b border-border-subtle pb-4 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <span className="w-8 h-8 rounded bg-dark-primary flex items-center justify-center text-white font-mono font-bold text-xs">
              {(currentRepo?.name || 'GV').slice(0, 2).toUpperCase()}
            </span>
            <h1 className="font-headline text-display-md text-white font-bold">
              {currentRepo?.fullName || currentRepo?.name}
            </h1>
          </div>
          <p className="text-body-md text-slate-400">
            {currentRepo?.description || 'No description provided.'}
          </p>
        </div>

        <button
          onClick={() => loadReadme()}
          disabled={loadingReadme}
          className="text-slate-400 hover:text-white p-2 rounded hover:bg-slate-800 transition-colors"
          title="Reload README"
        >
          <span className="material-symbols-outlined text-[18px]">
            {loadingReadme ? 'sync' : 'refresh'}
          </span>
        </button>
      </div>

      {/* Content Area */}
      {loadingReadme ? (
        <div className="flex flex-col items-center justify-center py-20 space-y-3">
          <span className="w-8 h-8 border-2 border-dark-primary border-t-transparent rounded-full animate-spin"></span>
          <span className="text-xs font-mono text-slate-400">Fetching README.md from GitHub...</span>
        </div>
      ) : readmeError ? (
        <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle text-center space-y-3">
          <span className="material-symbols-outlined text-[32px] text-slate-500">description</span>
          <h3 className="font-headline font-semibold text-white text-sm">README Documentation Unavailable</h3>
          <p className="text-xs font-mono text-slate-400 max-w-sm mx-auto">{readmeError}</p>
          <div className="pt-2">
            <button
              onClick={() => setMainViewMode('code')}
              className="px-4 py-2 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-xs transition-colors"
            >
              Browse Source Files Instead
            </button>
          </div>
        </div>
      ) : (
        <article className="space-y-4">
          <div className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle">
            <div className="prose prose-invert max-w-none">
              {renderSafeMarkdown(readmeContent)}
            </div>
          </div>

          <div className="pt-6 border-t border-border-subtle flex items-center gap-3">
            <button
              onClick={() => setMainViewMode('code')}
              className="px-4 py-2 rounded bg-dark-primary hover:bg-blue-500 text-white font-label text-xs transition-colors flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">code</span>
              <span>Inspect Source Files</span>
            </button>
            <button
              onClick={() => setMainViewMode('deps')}
              className="px-4 py-2 rounded bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-300 font-label text-xs transition-colors flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">package_2</span>
              <span>View Dependencies</span>
            </button>
            {readmeMeta?.htmlUrl && (
              <a
                href={readmeMeta.htmlUrl}
                target="_blank"
                rel="noreferrer"
                className="px-4 py-2 rounded bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-400 hover:text-white font-label text-xs transition-colors flex items-center gap-1.5 ml-auto"
              >
                <span>Open on GitHub</span>
                <span className="material-symbols-outlined text-[14px]">open_in_new</span>
              </a>
            )}
          </div>
        </article>
      )}
    </div>
  );
};
