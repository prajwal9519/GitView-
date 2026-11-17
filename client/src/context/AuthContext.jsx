import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { authService } from '../services/authService';

const AuthContext = createContext(null);

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch current user on mount to restore session from HTTP-only cookie
  useEffect(() => {
    let isMounted = true;

    authService
      .getCurrentUser()
      .then((userData) => {
        if (isMounted) {
          setUser(userData);
        }
      })
      .catch(() => {
        // Not authenticated or session expired
        if (isMounted) {
          setUser(null);
        }
      })
      .finally(() => {
        if (isMounted) {
          setLoading(false);
        }
      });

    const handleSessionExpired = () => {
      if (isMounted) {
        setUser(null);
      }
    };

    window.addEventListener('auth:session-expired', handleSessionExpired);

    return () => {
      isMounted = false;
      window.removeEventListener('auth:session-expired', handleSessionExpired);
    };
  }, []);

  const login = useCallback(async (credentials) => {
    const loggedInUser = await authService.login(credentials);
    setUser(loggedInUser);
    return loggedInUser;
  }, []);

  const register = useCallback(async (userData) => {
    const registeredUser = await authService.register(userData);
    setUser(registeredUser);
    return registeredUser;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      // Clear user even if logout request fails
    } finally {
      setUser(null);
    }
  }, []);

  const updateUserProfile = useCallback((updatedFields) => {
    setUser((prev) => (prev ? { ...prev, ...updatedFields } : null));
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        isAuthenticated: !!user,
        login,
        register,
        logout,
        updateUserProfile
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
