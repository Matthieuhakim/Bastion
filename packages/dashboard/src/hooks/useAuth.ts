import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { createElement } from 'react';

interface AuthContextValue {
  apiKey: string | null;
  isAuthenticated: boolean;
  login: (key: string) => Promise<void>;
  logout: () => void;
  error: string | null;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [apiKey, setApiKey] = useState<string | null>(() =>
    sessionStorage.getItem('bastion_api_key'),
  );
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (key: string) => {
    setError(null);
    try {
      const res = await fetch('/v1/agents', {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (!res.ok) {
        throw new Error('Invalid API key');
      }
      sessionStorage.setItem('bastion_api_key', key);
      setApiKey(key);
    } catch (_err) {
      setError(_err instanceof Error ? _err.message : 'Authentication failed');
      throw _err;
    }
  }, []);

  const logout = useCallback(() => {
    sessionStorage.removeItem('bastion_api_key');
    setApiKey(null);
  }, []);

  return createElement(
    AuthContext.Provider,
    { value: { apiKey, isAuthenticated: apiKey !== null, login, logout, error } },
    children,
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return ctx;
}
