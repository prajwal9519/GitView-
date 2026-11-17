import React from 'react';

export const Badge = ({
  children,
  variant = 'default',
  dotColor,
  pulse = false,
  className = '',
  size = 'sm'
}) => {
  const sizeClasses = {
    xs: 'px-1.5 py-0.5 text-[10px]',
    sm: 'px-2 py-0.5 text-[11px]',
    md: 'px-2.5 py-1 text-xs'
  };

  const variantClasses = {
    default: 'bg-dark-surface-container border border-border-strong text-slate-300 font-mono',
    success: 'bg-emerald-950/70 border border-emerald-500/30 text-emerald-400 font-mono',
    warning: 'bg-amber-950/70 border border-amber-500/30 text-amber-400 font-mono',
    danger: 'bg-red-950/70 border border-red-500/30 text-red-400 font-mono',
    info: 'bg-blue-950/70 border border-blue-500/30 text-blue-300 font-mono',
    accent: 'bg-accent-subtle border border-accent/30 text-accent-text font-mono',
    pill: 'rounded-full bg-dark-surface-container border border-border-subtle text-slate-300 font-mono'
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded ${sizeClasses[size]} ${variantClasses[variant] || variantClasses.default} ${className}`}
    >
      {dotColor && (
        <span
          className={`w-1.5 h-1.5 rounded-full ${dotColor} ${pulse ? 'animate-pulse' : ''}`}
        ></span>
      )}
      {children}
    </span>
  );
};
