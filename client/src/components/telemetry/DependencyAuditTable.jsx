import React from 'react';

export const DependencyAuditTable = ({ dependencies = [] }) => {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-headline text-headline-sm font-semibold text-white">
            Packages &amp; Dependency Audit
          </h2>
          <p className="text-body-sm text-slate-400">
            Deep inspection of manifests with license compliance
          </p>
        </div>
        <span className="text-xs font-mono text-slate-400">pnpm-lock.yaml v8</span>
      </div>

      <div className="bg-dark-surface-container border border-border-subtle rounded-xl overflow-hidden">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-[#080C14] text-slate-400 uppercase tracking-wider border-b border-border-subtle">
            <tr>
              <th className="py-3 px-4 font-medium">Package</th>
              <th className="py-3 px-4 font-medium">Installed Version</th>
              <th className="py-3 px-4 font-medium">License</th>
              <th className="py-3 px-4 font-medium">Type</th>
              <th className="py-3 px-4 font-medium text-right">Audit Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle text-slate-300">
            {dependencies.map((dep) => (
              <tr key={dep.name} className="hover:bg-dark-surface-container-high/40 transition-colors">
                <td className="py-3.5 px-4 font-semibold text-white">{dep.name}</td>
                <td className="py-3.5 px-4 text-blue-400">{dep.version}</td>
                <td className="py-3.5 px-4">{dep.license}</td>
                <td className="py-3.5 px-4">
                  <span className="px-2 py-0.5 rounded bg-[#090D16] text-slate-400">
                    {dep.type}
                  </span>
                </td>
                <td className="py-3.5 px-4 text-right text-emerald-400">{dep.audit}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};
