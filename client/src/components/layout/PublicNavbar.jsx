import React from 'react';
import { Link } from 'react-router-dom';

export const PublicNavbar = () => {
  return (
    <header className="sticky top-0 z-50 w-full border-b border-border-subtle bg-dark-surface/90 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded bg-gradient-to-tr from-dark-primary to-accent flex items-center justify-center text-white font-mono font-bold text-xs tracking-wider shadow-sm">
              GV
            </div>
            <span className="font-headline font-bold text-lg text-white tracking-tight">GitView</span>
            <span className="px-2 py-0.5 rounded text-[11px] font-mono bg-border-subtle text-slate-300 border border-border-strong">
              v2.4
            </span>
          </Link>

          <nav className="hidden md:flex items-center gap-6 text-body-sm text-slate-300">
            <a href="#how-it-works" className="hover:text-white transition-colors">How it works</a>
            <a href="#features" className="hover:text-white transition-colors">Features</a>
            <Link to="/workspace" className="hover:text-white transition-colors flex items-center gap-1.5">
              <span>Workspace</span>
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse"></span>
            </Link>
            <Link to="/repo/shadcn-ui-ui" className="hover:text-white transition-colors">Repo Inspector</Link>
            <Link to="/dashboard" className="hover:text-white transition-colors">Dashboard</Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <a
            href="https://github.com"
            target="_blank"
            rel="noreferrer"
            className="hidden sm:flex items-center gap-1.5 text-xs font-mono text-slate-400 hover:text-white px-2.5 py-1.5 rounded border border-border-subtle bg-dark-surface-container transition-colors"
          >
            <span className="material-symbols-outlined text-[15px]">star</span>
            <span>14.2k stars</span>
          </a>
          <Link
            to="/auth"
            className="text-label-md font-label text-slate-300 hover:text-white px-3 py-1.5 transition-colors"
          >
            Sign In
          </Link>
          <Link
            to="/auth?mode=register"
            className="text-label-md font-label px-3.5 py-1.5 rounded bg-dark-primary hover:bg-blue-500 text-white transition-colors shadow-sm"
          >
            Get Started
          </Link>
        </div>
      </div>
    </header>
  );
};
