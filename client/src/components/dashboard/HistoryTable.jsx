import React from 'react';
import { Link } from 'react-router-dom';

export const HistoryTable = ({ sessions = [] }) => {
  const getStatusBadge = (status, label) => {
    if (status === 'running') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-emerald-950/70 text-emerald-400 border border-emerald-500/30 font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>
          <span>{label}</span>
        </span>
      );
    }
    if (status === 'failed') {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-danger-subtle text-danger-text border border-danger/30 font-mono">
          <span className="w-1.5 h-1.5 rounded-full bg-danger"></span>
          <span>{label}</span>
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-slate-800 text-slate-400 border border-slate-700 font-mono">
        <span>{label}</span>
      </span>
    );
  };

  return (
    <div className="bg-dark-surface-container border border-border-subtle rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs font-mono">
          <thead className="bg-[#080C14] text-slate-400 uppercase tracking-wider border-b border-border-subtle">
            <tr>
              <th className="py-3 px-4 font-medium">Repository</th>
              <th className="py-3 px-4 font-medium">Branch</th>
              <th className="py-3 px-4 font-medium">Runtime / Port</th>
              <th className="py-3 px-4 font-medium">Last Active</th>
              <th className="py-3 px-4 font-medium">Status</th>
              <th className="py-3 px-4 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle text-slate-300">
            {sessions.map((sess) => (
              <tr
                key={sess.id}
                className="hover:bg-dark-surface-container-high/40 transition-colors"
              >
                <td className="py-3.5 px-4 font-semibold text-white flex items-center gap-2">
                  <span
                    className={`material-symbols-outlined text-[16px] ${
                      sess.status === 'running'
                        ? 'text-blue-400'
                        : sess.status === 'failed'
                        ? 'text-amber-400'
                        : 'text-slate-400'
                    }`}
                  >
                    {sess.status === 'failed' ? 'warning' : 'folder_open'}
                  </span>
                  <span>{sess.repoFullName}</span>
                </td>
                <td className="py-3.5 px-4 text-slate-400">{sess.branch}</td>
                <td className="py-3.5 px-4">{sess.runtime}</td>
                <td className="py-3.5 px-4 text-slate-400">{sess.lastActive}</td>
                <td className="py-3.5 px-4">
                  {getStatusBadge(sess.status, sess.statusLabel)}
                </td>
                <td className="py-3.5 px-4 text-right">
                  <Link
                    to={sess.actionLink}
                    className={`hover:underline font-mono ${
                      sess.status === 'running' ? 'text-blue-400 hover:text-blue-300' : 'text-slate-400 hover:text-white'
                    }`}
                  >
                    {sess.actionText}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
