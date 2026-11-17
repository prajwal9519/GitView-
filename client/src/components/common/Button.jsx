import React from 'react';

export const Button = ({
  children,
  variant = 'primary',
  size = 'md',
  icon,
  iconPosition = 'left',
  loading = false,
  disabled = false,
  className = '',
  onClick,
  type = 'button',
  title,
  ...props
}) => {
  const baseClasses = 'inline-flex items-center justify-center font-label transition-all duration-state-change rounded shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dark-primary focus-visible:ring-offset-2 focus-visible:ring-offset-dark-surface select-none';

  const sizeClasses = {
    sm: 'px-2.5 py-1 text-label-sm gap-1.5',
    md: 'px-3.5 py-2 text-label-md gap-2',
    lg: 'px-5 py-2.5 text-label-lg gap-2.5'
  };

  const variantClasses = {
    primary: 'bg-dark-primary hover:bg-blue-500 text-white active:translate-y-px',
    secondary: 'bg-transparent hover:bg-dark-surface-container border border-border-subtle text-slate-300 hover:text-white',
    surface: 'bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle hover:border-border-strong text-slate-200 active:translate-y-px',
    danger: 'bg-danger hover:bg-red-600 text-white active:translate-y-px shadow',
    ghost: 'hover:bg-dark-surface-container/60 text-slate-400 hover:text-white',
    icon: 'p-1.5 rounded bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle text-slate-400 hover:text-white'
  };

  const disabledClasses = 'opacity-60 cursor-not-allowed pointer-events-none';

  return (
    <button
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      title={title}
      className={`
        ${baseClasses}
        ${variant === 'icon' ? '' : sizeClasses[size]}
        ${variantClasses[variant] || variantClasses.primary}
        ${(disabled || loading) ? disabledClasses : ''}
        ${className}
      `}
      {...props}
    >
      {loading ? (
        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin"></span>
      ) : (
        <>
          {icon && iconPosition === 'left' && (
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
          )}
          {children}
          {icon && iconPosition === 'right' && (
            <span className="material-symbols-outlined text-[18px]">{icon}</span>
          )}
        </>
      )}
    </button>
  );
};
