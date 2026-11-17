import React from 'react';

export const TelemetryCard = ({ telemetry = {} }) => {
  const memoryMb = telemetry.memoryMb || 142;
  const memoryCap = telemetry.memoryCapMb || 512;
  const memoryPct = telemetry.memoryPercentage || Math.round((memoryMb / memoryCap) * 100);
  const hmrMs = telemetry.hmrLatencyMs || 34;
  const diskOps = telemetry.virtualDiskOpsPerSec || 1820;

  return (
    <section className="p-6 rounded-xl bg-dark-surface-container border border-border-subtle space-y-4">
      <h2 className="font-headline text-headline-sm font-semibold text-white">
        Cloud Container Telemetry
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs font-mono">
        <div className="p-3 bg-[#080C14] rounded-lg border border-border-subtle">
          <span className="text-slate-500 block">CONTAINER MEMORY USAGE</span>
          <span className="text-sm font-bold text-white mt-1 block">
            {memoryMb} MB / {memoryCap} MB ({memoryPct}%)
          </span>
          <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
            <div style={{ width: `${memoryPct}%` }} className="h-full bg-emerald-400"></div>
          </div>
        </div>

        <div className="p-3 bg-[#080C14] rounded-lg border border-border-subtle">
          <span className="text-slate-500 block">HOT MODULE RELOAD LATENCY</span>
          <span className="text-sm font-bold text-accent mt-1 block">
            {hmrMs} ms
          </span>
          <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
            <div style={{ width: `${Math.min(100, (hmrMs / 100) * 100)}%` }} className="h-full bg-accent"></div>
          </div>
        </div>

        <div className="p-3 bg-[#080C14] rounded-lg border border-border-subtle">
          <span className="text-slate-500 block">VIRTUAL DISK I/O</span>
          <span className="text-sm font-bold text-white mt-1 block">
            {diskOps.toLocaleString()} read ops / sec
          </span>
          <div className="w-full h-1 bg-slate-800 rounded-full mt-2 overflow-hidden">
            <div className="w-[45%] h-full bg-blue-400"></div>
          </div>
        </div>
      </div>
    </section>
  );
};
