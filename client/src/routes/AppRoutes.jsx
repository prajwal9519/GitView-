import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { LandingPage } from '../pages/LandingPage';
import { AuthPage } from '../pages/AuthPage';
import { DashboardPage } from '../pages/DashboardPage';
import { ImportRepoPage } from '../pages/ImportRepoPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { RepoDetailsPage } from '../pages/RepoDetailsPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ProtectedRoute, PublicOnlyRoute } from './ProtectedRoute';

export const AppRoutes = () => {
  return (
    <Routes>
      {/* Public Pages */}
      <Route path="/" element={<LandingPage />} />

      {/* Guest / Auth Pages (redirect to dashboard if already authenticated) */}
      <Route
        path="/auth"
        element={
          <PublicOnlyRoute>
            <AuthPage />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/login"
        element={
          <PublicOnlyRoute>
            <AuthPage initialMode="signin" />
          </PublicOnlyRoute>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnlyRoute>
            <AuthPage initialMode="signup" />
          </PublicOnlyRoute>
        }
      />

      {/* Protected Application Pages */}
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <DashboardPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/import"
        element={
          <ProtectedRoute>
            <ImportRepoPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/workspace"
        element={
          <ProtectedRoute>
            <WorkspacePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/workspace/:repoId"
        element={
          <ProtectedRoute>
            <WorkspacePage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/repo/:repoId"
        element={
          <ProtectedRoute>
            <RepoDetailsPage />
          </ProtectedRoute>
        }
      />
      <Route
        path="/repo-details"
        element={
          <ProtectedRoute>
            <Navigate to="/repo/shadcn-ui-ui" replace />
          </ProtectedRoute>
        }
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <SettingsPage />
          </ProtectedRoute>
        }
      />

      {/* Catch-all redirect */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};
