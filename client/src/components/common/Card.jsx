import React from 'react';

export const Card = ({
  children,
  variant = 'elevated',
  className = '',
  onClick,
  ...props
}) => {
  const baseClasses = 'rounded-xl transition-all duration-surface-enter';

  const variantClasses = {
    elevated: 'bg-dark-surface-container border border-border-subtle hover:border-border-strong p-5',
    interactive: 'bg-dark-surface-container hover:bg-dark-surface-container-high border border-border-subtle hover:border-accent p-5 cursor-pointer',
    flat: 'bg-[#080C14] border border-border-subtle p-4',
    hero: 'bg-dark-surface-container border border-border-strong rounded-xl p-6 shadow-2xl'
  };

  return (
    <div
      onClick={onClick}
      className={`${baseClasses} ${variantClasses[variant] || variantClasses.elevated} ${className}`}
      {...props}
    >
      {children}
    </div>
  );
};
