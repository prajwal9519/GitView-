import React from 'react';

export const InputField = ({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  icon,
  rightElement,
  error,
  hint,
  required = false,
  fontMono = false,
  className = '',
  id,
  name,
  disabled = false,
  ...props
}) => {
  return (
    <div className="w-full space-y-1.5">
      {label && (
        <label htmlFor={id} className="block text-label-md font-label text-slate-300">
          {label} {required && <span className="text-red-400">*</span>}
        </label>
      )}

      <div className="relative flex items-center">
        {icon && (
          <span
            className={`material-symbols-outlined absolute left-3 text-[18px] select-none ${
              error ? 'text-danger' : 'text-slate-400'
            }`}
          >
            {icon}
          </span>
        )}

        <input
          id={id}
          name={name}
          type={type}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          disabled={disabled}
          className={`
            w-full bg-[#080C14] border text-white text-body-md rounded-lg transition-colors placeholder:text-slate-600 focus:outline-none
            ${fontMono ? 'font-mono text-xs' : ''}
            ${icon ? 'pl-9' : 'px-3'}
            ${rightElement ? 'pr-24' : 'pr-3'}
            py-2.5
            ${
              error
                ? 'border-danger focus:border-danger focus:ring-1 focus:ring-danger'
                : 'border-border-subtle focus:border-dark-primary focus:ring-1 focus:ring-dark-primary'
            }
            ${disabled ? 'opacity-60 cursor-not-allowed' : ''}
            ${className}
          `}
          {...props}
        />

        {rightElement && (
          <div className="absolute right-2 flex items-center">
            {rightElement}
          </div>
        )}
      </div>

      {error ? (
        <span role="alert" className="text-body-sm text-danger flex items-center gap-1 mt-1 block">
          <span className="material-symbols-outlined text-[14px]">error</span>
          {error}
        </span>
      ) : hint ? (
        <span className="text-body-sm text-slate-500 mt-1 block">
          {hint}
        </span>
      ) : null}
    </div>
  );
};
