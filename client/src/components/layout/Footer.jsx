import React from 'react';
import { Link } from 'react-router-dom';

export const Footer = () => {
  return (
    <footer className="w-full bg-[#07090F] border-t border-border-subtle py-12 text-slate-400 text-body-sm">
      <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row items-center justify-between gap-6">
        <div className="flex items-center gap-3">
          <div className="w-6 h-6 rounded bg-dark-primary flex items-center justify-center text-white font-mono text-xs font-bold">
            GV
          </div>
          <span className="text-white font-headline font-semibold text-sm">GitView</span>
          <span className="text-xs text-slate-600 font-mono">© 2026 GitView Labs, Inc.</span>
        </div>

        <div className="flex items-center gap-6 text-xs font-mono">
          <Link to="/" className="hover:text-white transition-colors">Home</Link>
          <Link to="/dashboard" className="hover:text-white transition-colors">Dashboard</Link>
          <Link to="/workspace" className="hover:text-white transition-colors">Workspace</Link>
          <Link to="/settings" className="hover:text-white transition-colors">Settings</Link>
          <Link to="/auth" className="hover:text-white transition-colors">Auth</Link>
        </div>

        <div className="text-xs font-mono text-slate-500">
          Engineered for engineers.
        </div>
      </div>
    </footer>
  );
};
