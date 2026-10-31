import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, setUnauthorizedHandler } from './lib/api';
import { AuthContext, can, useAuth, type Permission } from './lib/auth';
import type { Me } from './lib/types';
import { Layout } from './components/Layout';
import { ChangePasswordPage, LoginPage, ResetPasswordPage, SetupPage } from './pages/Auth';
import { DashboardPage } from './pages/Dashboard';
import { CompaniesPage, CompanyDetailPage } from './pages/Companies';
import { SourceDetailPage, SourcesPage } from './pages/Sources';
import { RecordDetailPage, RecordsPage } from './pages/Records';
import { CategoriesPage } from './pages/Categories';
import { UsersPage } from './pages/Users';
import { AutomationPage } from './pages/Automation';
import { SettingsPage } from './pages/Settings';
import { PlansPage } from './pages/Plans';
import { OfferDetailPage, OffersPage } from './pages/Offers';
import { ReviewPage } from './pages/Review';
import { ParsersPage } from './pages/Parsers';
import { LegalPage } from './pages/Legal';
import { IncidentPage, IntegrationsPage, PrivacyPage, QueuePage } from './pages/Operations';

export function AuthProvider({ children, initialMe }: { children: ReactNode; initialMe?: Me | null }) {
  const [me, setMe] = useState<Me | null>(initialMe ?? null);
  const [ready, setReady] = useState(initialMe !== undefined);
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/auth/me', { skipAuthRedirect: true }));
    } catch {
      setMe(null);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    if (initialMe === undefined) void refresh();
  }, [initialMe, refresh]);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setMe(null);
      navigate('/login', { replace: true });
    });
    return () => setUnauthorizedHandler(null);
  }, [navigate]);

  const value = useMemo(() => ({ me, setMe, refresh }), [me, refresh]);
  if (!ready) {
    return (
      <p className="boot muted" role="status" aria-live="polite">
        Loading Due Admin…
      </p>
    );
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function RequireAuth({ children, perm = 'read' }: { children: ReactNode; perm?: Permission }) {
  const { me } = useAuth();
  const location = useLocation();
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (!can(me.role, perm)) {
    return (
      <div className="empty" role="alert">
        Your role ({me.role}) cannot open this page.
      </div>
    );
  }
  return <>{children}</>;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="companies" element={<CompaniesPage />} />
        <Route path="companies/:id" element={<CompanyDetailPage />} />
        <Route path="sources" element={<SourcesPage />} />
        <Route path="sources/:id" element={<SourceDetailPage />} />
        <Route path="records" element={<RecordsPage />} />
        <Route path="records/:id" element={<RecordDetailPage />} />
        <Route path="categories" element={<CategoriesPage />} />
        <Route path="automation" element={<AutomationPage />} />
        <Route
          path="users"
          element={
            <RequireAuth perm="admin">
              <UsersPage />
            </RequireAuth>
          }
        />
        <Route path="offers" element={<OffersPage />} />
        <Route path="offers/:id" element={<OfferDetailPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="parsers" element={<ParsersPage />} />
        <Route path="integrations" element={<IntegrationsPage />} />
        <Route path="queue" element={<QueuePage />} />
        <Route path="incident" element={<IncidentPage />} />
        <Route
          path="privacy"
          element={
            <RequireAuth perm="admin">
              <PrivacyPage />
            </RequireAuth>
          }
        />
        <Route path="plans" element={<PlansPage />} />
        <Route path="legal" element={<LegalPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="account" element={<ChangePasswordPage />} />
        <Route path="*" element={<div className="empty">Page not found.</div>} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <AuthProvider>
      <AppRoutes />
    </AuthProvider>
  );
}
