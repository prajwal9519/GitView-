import React from 'react';

export const Tabs = ({
  tabs = [],
  activeTab,
  onChange,
  variant = 'horizontal',
  className = ''
}) => {
  if (variant === 'segmented') {
    return (
      <div className={`grid p-1 bg-[#090D16] border border-border-subtle rounded-lg text-xs font-label ${className}`} style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              className={`py-1.5 px-3 rounded text-center transition-all duration-state-change font-medium ${
                isActive
                  ? 'bg-dark-surface-container text-white shadow-sm'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
    );
  }

  // Default horizontal workspace tabs
  return (
    <div className={`flex items-center p-1 rounded-lg bg-[#070A10] border border-border-subtle text-xs font-label gap-1 ${className}`}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`flex items-center gap-1.5 px-3 py-1 rounded transition-all duration-state-change ${
              isActive
                ? 'bg-dark-surface-container text-white font-medium border border-border-subtle shadow-sm'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            {tab.icon && (
              <span className={`material-symbols-outlined text-[15px] ${isActive ? 'text-blue-400' : ''}`}>
                {tab.icon}
              </span>
            )}
            <span>{tab.label}</span>
            {tab.badge !== undefined && (
              <span className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-slate-800 text-slate-400">
                {tab.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};
