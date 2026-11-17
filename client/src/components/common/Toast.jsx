import React from 'react';

export const Toast = ({
  title,
  message,
  variant = 'success',
  onClose,
  className = ''
}) => {
  const isSuccess = variant === 'success';
  const isError = variant === 'error';

  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live="polite"
      className={`flex items-start gap-3 p-3.5 bg-dark-surface-container-high border rounded-lg shadow-xl transition-all duration-surface-enter ${
        isSuccess ? 'border-success/30' : isError ? 'border-danger/30' : 'border-border-strong'
      } ${className}`}
    >
      <span
        className={`material-symbols-outlined text-[20px] mt-0.5 ${
          isSuccess ? 'text-success' : isError ? 'text-danger' : 'text-blue-400'
        }`}
      >
        {isSuccess ? 'check_circle' : isError ? 'error' : 'info'}
      </span>

      <div className="flex-1">
        {title && <h4 className="text-label-md font-headline text-white font-medium">{title}</h4>}
        {message && <p className="text-body-sm text-slate-400 mt-0.5">{message}</p>}
      </div>

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label="Dismiss message"
          className="text-slate-500 hover:text-slate-300 transition-colors p-0.5"
        >
          <span className="material-symbols-outlined text-[16px]">close</span>
        </button>
      )}
    </div>
  );
};
