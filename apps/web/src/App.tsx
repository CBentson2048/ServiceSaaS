import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DashboardLayout } from './layouts/DashboardLayout';
import { AcceptInvitationPage } from './pages/AcceptInvitationPage';
import { AccountCreatedPage } from './pages/AccountCreatedPage';
import { CreateLocationPage } from './pages/CreateLocationPage';
import { DashboardPage } from './pages/DashboardPage';
import { EditLocationPage } from './pages/EditLocationPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { LocationDetailPage } from './pages/LocationDetailPage';
import { LocationsPage } from './pages/LocationsPage';
import { LoginPage } from './pages/LoginPage';
import { OwnerOnboardingPage } from './pages/OwnerOnboardingPage';
import { PasswordResetCompletePage } from './pages/PasswordResetCompletePage';
import { PlaceholderPage } from './pages/PlaceholderPage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { TeamPage } from './pages/TeamPage';
import { UnauthorizedPage } from './pages/UnauthorizedPage';

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/create-account" element={<Navigate to="/owner/onboarding" replace />} />
      <Route path="/owner/onboarding" element={<OwnerOnboardingPage />} />
      <Route path="/staff/accept-invite" element={<AcceptInvitationPage />} />
      {/*
        Public, auth-adjacent routes (account claim + password reset).
        Deliberately mounted OUTSIDE the dashboard ProtectedRoute so
        they do not require an owner/manager session and do not bypass
        dashboard guards for any other route.
      */}
      <Route path="/auth/account-created" element={<AccountCreatedPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/auth/reset-password" element={<ResetPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/auth/password-reset-complete" element={<PasswordResetCompletePage />} />
      <Route
        path="/password-reset-complete"
        element={<Navigate to="/auth/password-reset-complete" replace />}
      />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />
      <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} />}>
        <Route element={<DashboardLayout />}>
          <Route index element={<DashboardPage />} />
          <Route path="/bookings" element={<PlaceholderPage title="Bookings" />} />
          <Route path="/crm" element={<PlaceholderPage title="CRM" />} />
          <Route path="/rota" element={<PlaceholderPage title="Rota" />} />
          <Route path="/sheer-lab" element={<PlaceholderPage title="Sheer Lab" />} />
          <Route path="/commission" element={<PlaceholderPage title="Commission" />} />
          <Route path="/locations" element={<LocationsPage />} />
          <Route path="/locations/:id" element={<LocationDetailPage />} />
        </Route>
      </Route>
      <Route element={<ProtectedRoute allowedRoles={['owner']} />}>
        <Route element={<DashboardLayout />}>
          <Route path="/team" element={<TeamPage />} />
          <Route path="/locations/new" element={<CreateLocationPage />} />
          <Route path="/locations/:id/edit" element={<EditLocationPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
