import {
  BrowserRouter,
  MemoryRouter,
  Navigate,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import React, { type ReactNode } from 'react';
import AppShell from './components/AppShell';
import { AppProvider } from './context/AppContext';
import { AnnotationProvider } from './context/AnnotationContext';
import { WorkModeProvider } from './context/WorkModeContext';
import { AnnotationWorkspaceProvider } from './context/AnnotationWorkspaceContext';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/Layout';
import RequireAuth from './components/RequireAuth';
import AuthPage from './pages/AuthPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import ResetPasswordDeepLinkListener from './components/ResetPasswordDeepLinkListener';
import MotionProvider from './motion/MotionProvider';
import PageTransition from './motion/PageTransition';
import { PretrainedModelsProvider } from './context/PretrainedModelsContext';
import { LlmProvidersProvider } from './context/LlmProvidersContext';
import { AgentChatProvider } from './context/AgentChatContext';
import { ThemeProvider } from './context/ThemeContext';
import { EnvironmentProvider } from './context/EnvironmentContext';
import './vscode-setup';
import './App.css';

function AppProviders({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppProvider>
          <EnvironmentProvider>
            <PretrainedModelsProvider>
              <LlmProvidersProvider>
                <AnnotationProvider>
                  <WorkModeProvider>
                    <AgentChatProvider>
                      <AnnotationWorkspaceProvider>
                        {children}
                      </AnnotationWorkspaceProvider>
                    </AgentChatProvider>
                  </WorkModeProvider>
                </AnnotationProvider>
              </LlmProvidersProvider>
            </PretrainedModelsProvider>
          </EnvironmentProvider>
        </AppProvider>
      </ToastProvider>
    </AuthProvider>
  );
}

function AppRouteViews() {
  const location = useLocation();
  const standalone =
    location.pathname === '/verify' || location.pathname === '/reset-password';

  const routes = (
    <Routes>
      <Route
        path="/verify"
        element={
          <PageTransition routeKey="/verify">
            <VerifyEmailPage />
          </PageTransition>
        }
      />
      <Route
        path="/reset-password"
        element={
          <PageTransition routeKey="/reset-password">
            <ResetPasswordPage />
          </PageTransition>
        }
      />
      <Route
        path="/auth"
        element={
          <PageTransition routeKey="/auth" className="app-shell-transition">
            <AuthPage />
          </PageTransition>
        }
      />
      <Route path="/index.html" element={<Navigate to="/" replace />} />
      <Route element={<RequireAuth />}>
        <Route
          path="/"
          element={
            <PageTransition routeKey="/" className="app-shell-transition">
              <Layout />
            </PageTransition>
          }
        />
      </Route>
    </Routes>
  );

  if (standalone) {
    return routes;
  }

  return <AppShell>{routes}</AppShell>;
}

function isElectronShell(): boolean {
  return (
    Boolean(window.electron?.platform) || /Electron/i.test(navigator.userAgent)
  );
}

export default function App() {
  const isElectron = isElectronShell();
  const isHttpApp =
    !isElectron &&
    (window.location.protocol === 'http:' ||
      window.location.protocol === 'https:');
  const Router = isHttpApp ? BrowserRouter : MemoryRouter;

  return (
    <ThemeProvider>
      <MotionProvider>
        <Router>
          <ResetPasswordDeepLinkListener />
          <AppProviders>
            <AppRouteViews />
          </AppProviders>
        </Router>
      </MotionProvider>
    </ThemeProvider>
  );
}
