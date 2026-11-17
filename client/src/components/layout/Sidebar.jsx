import React from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export const Sidebar = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { user, logout } = useAuth();

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const navItems = [
    { label: 'Overview', path: '/dashboard', icon: 'dashboard' },
    { label: 'Workspace (Hero)', path: '/workspace', icon: 'desktop_windows', isLive: true },
    { label: 'Import Repository', path: '/import', icon: 'cloud_upload' },
    { label: 'Repo Telemetry', path: '/repo/shadcn-ui-ui', icon: 'analytics' },
    { label: 'Settings & Account', path: '/settings', icon: 'settings' }
  ];

  const userInitials = (user?.username || 'GV').slice(0, 2).toUpperCase();

  return (
    <aside className="w-full md:w-64 bg-[#080C14] border-r border-border-subtle flex flex-col justify-between shrink-0 select-none">
      <div>
        {/* Brand & Project Switcher */}
        <div className="h-16 px-5 border-b border-border-subtle flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded bg-dark-primary flex items-center justify-center text-white font-mono font-bold text-xs shadow-sm">
              GV
            </div>
            <span className="font-headline font-bold text-base text-white tracking-tight">GitView</span>
          </Link>
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-dark-surface-container text-slate-400 border border-border-subtle">
            {user?.role || 'PRO'}
          </span>
        </div>

        {/* Quick Action: New Preview */}
        <div className="p-4 border-b border-border-subtle">
          <Link
            to="/import"
            className="w-full flex items-center justify-center gap-2 py-2 px-3.5 rounded-lg bg-dark-primary hover:bg-blue-500 text-white font-label text-label-md transition-colors shadow-sm"
          >
            <span className="material-symbols-outlined text-[18px]">add</span>
            <span>New Preview</span>
          </Link>
        </div>

        {/* Nav Items */}
        <nav className="p-3 space-y-1 text-sm font-label">
          {navItems.map((item) => {
            const isActive =
              location.pathname === item.path ||
              (item.path !== '/dashboard' && location.pathname.startsWith(item.path));
            return (
              <Link
                key={item.path}
                to={item.path}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
                  isActive
                    ? 'bg-dark-surface-container text-white border border-border-subtle font-medium'
                    : 'text-slate-400 hover:text-white hover:bg-dark-surface-container/50'
                }`}
              >
                <span
                  className={`material-symbols-outlined text-[20px] ${
                    isActive ? 'text-blue-400' : item.isLive ? 'text-accent' : ''
                  }`}
                >
                  {item.icon}
                </span>
                <span>{item.label}</span>
                {item.isLive && (
                  <span className="ml-auto w-2 h-2 rounded-full bg-accent animate-pulse"></span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* Active Sandboxes Summary */}
        <div className="p-4 mx-3 my-2 rounded-lg bg-[#0A0F1D] border border-border-subtle text-xs">
          <div className="flex items-center justify-between text-slate-300 font-mono mb-2">
            <span>RUNNING SANDBOXES</span>
            <span className="text-emerald-400 font-bold">2 / 5</span>
          </div>
          <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mb-2">
            <div className="w-2/5 h-full bg-emerald-500 rounded-full"></div>
          </div>
          <div className="flex items-center justify-between text-[11px] font-mono text-slate-500">
            <span>Memory: 412 MB</span>
            <span>WebContainers</span>
          </div>
        </div>
      </div>

      {/* Account Footer Profile */}
      <div className="p-3 border-t border-border-subtle bg-[#060910]">
        <div className="flex items-center justify-between p-2 rounded-lg bg-dark-surface-container/40 border border-border-subtle/50">
          <Link
            to="/settings"
            className="flex items-center gap-2.5 flex-1 min-w-0 group"
            title="Settings"
          >
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 flex items-center justify-center text-white font-mono text-xs font-bold shrink-0">
              {userInitials}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-semibold text-white leading-none truncate group-hover:text-blue-400 transition-colors">
                {user?.username || 'user'}
              </div>
              <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
                {user?.email || 'Authenticated'}
              </div>
            </div>
          </Link>
          <button
            type="button"
            onClick={handleLogout}
            title="Sign Out"
            className="text-slate-400 hover:text-red-400 p-1.5 rounded transition-colors ml-1 hover:bg-red-950/30"
          >
            <span className="material-symbols-outlined text-[18px]">logout</span>
          </button>
        </div>
      </div>
    </aside>
  );
};
