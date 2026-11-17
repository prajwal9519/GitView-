import React from 'react';

export const LanguageBreakdown = ({ breakdown = {} }) => {
  const colorMap = {
    TypeScript: 'bg-blue-500',
    'Tailwind CSS': 'bg-cyan-400',
    JavaScript: 'bg-amber-400',
    'JSON / Config': 'bg-slate-600',
    Rust: 'bg-orange-500',
    CSS: 'bg-cyan-500',
    HTML: 'bg-red-400',
    Other: 'bg-slate-600'
  };

  const entries = Object.entries(breakdown);

  return (
    <section className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle space-y-4">
      <h2 className="font-headline text-headline-sm font-semibold text-white">
        Language Breakdown
      </h2>

      {/* Multi-segment bar */}
      <div className="w-full h-3 rounded-full overflow-hidden flex bg-slate-800">
        {entries.map(([lang, pct]) => (
          <div
            key={lang}
            style={{ width: `${pct}%` }}
            className={`h-full ${colorMap[lang] || 'bg-slate-500'}`}
            title={`${lang} ${pct}%`}
          />
        ))}
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-6 text-xs font-mono">
        {entries.map(([lang, pct]) => (
          <div key={lang} className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${colorMap[lang] || 'bg-slate-500'}`} />
            <span className="text-white font-medium">{lang}</span>
            <span className="text-slate-500">{pct}%</span>
          </div>
        ))}
      </div>
    </section>
  );
};
