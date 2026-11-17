import React from 'react';
import { Sidebar } from './Sidebar';

export const AppLayout = ({ children }) => {
  return (
    <div className="min-h-screen bg-dark-surface text-dark-on-surface font-body antialiased flex flex-col md:flex-row h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-y-auto">
        {children}
      </div>
    </div>
  );
};
