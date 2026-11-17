import React from 'react';

export const MetricsBar = () => {
  const metrics = [
    {
      title: 'REPOSITORIES EXPLORED',
      value: '48',
      subtitle: '12 in past 7 days',
      icon: 'source',
      iconColor: 'text-slate-400'
    },
    {
      title: 'ACTIVE SANDBOX PREVIEWS',
      value: '2',
      subtitle: 'ports: 3000, 5173',
      icon: 'play_circle',
      iconColor: 'text-emerald-400',
      valueColor: 'text-emerald-400'
    },
    {
      title: 'AVG CONTAINER BOOT',
      value: '1.8s',
      subtitle: '98.4% faster than local',
      subtitleColor: 'text-emerald-400',
      icon: 'speed',
      iconColor: 'text-accent'
    },
    {
      title: 'GITHUB API RATE',
      value: '4,892 / 5k',
      subtitle: 'Resets in 42 minutes',
      icon: 'api',
      iconColor: 'text-blue-400'
    }
  ];

  return (
    <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {metrics.map((m) => (
        <div
          key={m.title}
          className="p-4 rounded-xl bg-dark-surface-container border border-border-subtle"
        >
          <div className="flex items-center justify-between text-slate-400 mb-1">
            <span className="text-xs font-mono">{m.title}</span>
            <span className={`material-symbols-outlined text-[18px] ${m.iconColor}`}>
              {m.icon}
            </span>
          </div>
          <div className={`text-2xl font-bold font-headline ${m.valueColor || 'text-white'}`}>
            {m.value}
          </div>
          <div className={`text-xs font-mono mt-1 ${m.subtitleColor || 'text-slate-500'}`}>
            {m.subtitle}
          </div>
        </div>
      ))}
    </section>
  );
};
