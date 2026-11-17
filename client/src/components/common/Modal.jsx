import React, { useEffect } from 'react';

export const Modal = ({
  isOpen,
  onClose,
  title,
  children,
  maxWidth = 'max-w-xl',
  className = ''
}) => {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/80 backdrop-blur-sm transition-opacity"
        onClick={onClose}
      />

      {/* Dialog card */}
      <div
        className={`relative w-full ${maxWidth} bg-dark-surface-container border border-border-strong rounded-xl shadow-2xl overflow-hidden z-10 duration-surface-enter ${className}`}
      >
        {children}
      </div>
    </div>
  );
};

export const CommandPaletteModal = ({
  isOpen,
  onClose,
  onSelectAction,
  onSelectFile,
  files = []
}) => {
  const [search, setSearch] = React.useState('');

  useEffect(() => {
    if (!isOpen) setSearch('');
  }, [isOpen]);

  const filteredFiles = files.filter((f) =>
    f.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="max-w-xl">
      {/* Search Header */}
      <div className="p-3 border-b border-border-subtle flex items-center gap-2.5 bg-[#090D16]">
        <span className="material-symbols-outlined text-slate-500 text-[18px]">search</span>
        <input
          type="text"
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Type a command or search files..."
          className="w-full bg-transparent border-none text-white text-xs font-mono placeholder:text-slate-600 focus:outline-none focus:ring-0 p-0"
        />
        <span className="text-[10px] font-mono text-slate-500 bg-dark-surface px-1.5 py-0.5 rounded border border-border-subtle">
          ESC
        </span>
      </div>

      {/* Results */}
      <div className="p-2 space-y-1 text-xs font-mono max-h-80 overflow-y-auto">
        <div className="px-2 py-1 text-[10px] text-slate-500 uppercase tracking-wider">
          Matching Files
        </div>

        {filteredFiles.length > 0 ? (
          filteredFiles.map((file) => (
            <div
              key={file}
              onClick={() => {
                onSelectFile?.(file);
                onClose();
              }}
              className="flex items-center justify-between p-2 rounded hover:bg-dark-surface-container-high text-slate-300 hover:text-white cursor-pointer transition-colors"
            >
              <div className="flex items-center gap-2">
                <span className="text-blue-400 font-bold text-[10px]">
                  {file.endsWith('.json') ? '{}' : file.endsWith('.md') ? 'MD' : 'TS'}
                </span>
                <span>{file}</span>
              </div>
              <span className="text-[10px] text-slate-500">Jump to file</span>
            </div>
          ))
        ) : (
          <div className="px-2 py-3 text-slate-500 text-center">No matching files</div>
        )}

        <div className="px-2 pt-2 pb-1 text-[10px] text-slate-500 uppercase tracking-wider border-t border-border-subtle mt-2">
          Actions
        </div>
        <div
          onClick={() => {
            onSelectAction?.('restart');
            onClose();
          }}
          className="flex items-center justify-between p-2 rounded hover:bg-dark-surface-container-high text-slate-300 hover:text-white cursor-pointer transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-[16px] text-accent">play_circle</span>
            <span>Restart Sandbox WebContainer</span>
          </div>
          <span className="text-[10px] text-slate-500">⌘R</span>
        </div>
      </div>
    </Modal>
  );
};
