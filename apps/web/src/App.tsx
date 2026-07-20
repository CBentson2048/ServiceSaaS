import { Routes, Route, Navigate } from 'react-router-dom';
import { ProtectedRoute } from './auth/ProtectedRoute';
import { DashboardLayout } from './layouts/DashboardLayout';
import { AcceptInvitationPage } from './pages/AcceptInvitationPage';
import { AccountCreatedPage } from './pages/AccountCreatedPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { AccountPlanPage } from './pages/AccountPlanPage';
import { BookingSettingsPage } from './pages/BookingSettingsPage';
import { BookOutTypesPage } from './pages/BookOutTypesPage';
import { SecurityLevelsPage } from './pages/SecurityLevelsPage';
import { ClientBookingAccountPage } from './pages/ClientBookingAccountPage';
import { ClientBookingDateTimePage } from './pages/ClientBookingDateTimePage';
import { ClientBookingLocationPage } from './pages/ClientBookingLocationPage';
import { ClientBookingReviewPage } from './pages/ClientBookingReviewPage';
import { ClientBookingServicePage } from './pages/ClientBookingServicePage';
import { ClientBookingSuccessPage } from './pages/ClientBookingSuccessPage';
import { BookingsPage } from './pages/BookingsPage';
import { CreateAccountPage } from './pages/CreateAccountPage';
import { CreateLocationPage } from './pages/CreateLocationPage';
import { CrmClientDetailPage } from './pages/CrmClientDetailPage';
import { CrmClientsPage } from './pages/CrmClientsPage';
import { DashboardPage } from './pages/DashboardPage';
import { DeleteAccountPage } from './pages/DeleteAccountPage';
import { EditLocationPage } from './pages/EditLocationPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { InventoryCategoriesPage } from './pages/InventoryCategoriesPage';
import { InventoryManagementPage } from './pages/InventoryManagementPage';
import { InventoryPage } from './pages/InventoryPage';
import { LandingPage } from './pages/LandingPage';
import { LocationDetailPage } from './pages/LocationDetailPage';
import { LocationRecordSettingsPage } from './pages/LocationRecordSettingsPage';
import { LocationsPage } from './pages/LocationsPage';
import { LoginPage } from './pages/LoginPage';
import { NewBookingPage } from './pages/NewBookingPage';
import { OwnerOnboardingPage } from './pages/OwnerOnboardingPage';
import { PasswordResetCompletePage } from './pages/PasswordResetCompletePage';
import { PerformancePage } from './pages/PerformancePage';
import { CommissionPage } from './pages/CommissionPage';
import { PrivacyPolicyPage } from './pages/PrivacyPolicyPage';
import { ProfilePage } from './pages/ProfilePage';
import { ResetPasswordPage } from './pages/ResetPasswordPage';
import { RotaPage } from './pages/RotaPage';
import { NewWeekRotaPage } from './pages/NewWeekRotaPage';
import { ServiceCategoriesPage } from './pages/ServiceCategoriesPage';
import { ServiceManagementPage } from './pages/ServiceManagementPage';
import { ServicesPage } from './pages/ServicesPage';
import { SheerLabPage } from './pages/SheerLabPage';
import { SupportPage } from './pages/SupportPage';
import { TeamPage } from './pages/TeamPage';
import { UnauthorizedPage } from './pages/UnauthorizedPage';

export function App() {
  return (
    <Routes>
      <Route index element={<LandingPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/create-account" element={<CreateAccountPage />} />
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
      {/*
        Public self-service account deletion (App Store Guideline 5.1.1(v)).
        This is the URL given to App Store Connect; a client signs in with their
        qlooqo app credentials to delete their own account. Both paths resolve to
        the same page so either can be used as the published link.
      */}
      <Route path="/delete-account" element={<DeleteAccountPage />} />
      <Route path="/account/delete" element={<DeleteAccountPage />} />
      {/*
        Public privacy policy (App Store App Privacy requirement).
        This is the Privacy Policy URL given to App Store Connect; mounted
        OUTSIDE the dashboard ProtectedRoute so it is reachable without a session.
      */}
      <Route path="/privacy-policy" element={<PrivacyPolicyPage />} />
      {/*
        Public support page (App Store Guideline 1.5 — Support URL).
        This is the URL given to App Store Connect (https://qlooqo.com/support);
        mounted OUTSIDE the dashboard ProtectedRoute so it is reachable without
        a session, alongside the privacy-policy and delete-account pages.
      */}
      <Route path="/support" element={<SupportPage />} />
      <Route path="/book/location" element={<ClientBookingLocationPage />} />
      <Route path="/book/service" element={<ClientBookingServicePage />} />
      <Route path="/book/date-time" element={<ClientBookingDateTimePage />} />
      <Route path="/book/account" element={<Navigate to="/login?booking=1" replace />} />
      <Route path="/book/contact" element={<Navigate to="/login?booking=1" replace />} />
      <Route path="/book/preference" element={<ClientBookingAccountPage />} />
      <Route path="/book/review" element={<ClientBookingReviewPage />} />
      <Route path="/book/success" element={<ClientBookingSuccessPage />} />
      <Route
        path="/password-reset-complete"
        element={<Navigate to="/auth/password-reset-complete" replace />}
      />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />
      <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} />}>
        <Route element={<DashboardLayout />}>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['report.dashboard.view']} />}>
            <Route path="/dashboard" element={<DashboardPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['bookings.manage']} />}>
            <Route path="/bookings" element={<BookingsPage />} />
            <Route path="/bookings/new" element={<NewBookingPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['report.lab_analytics.view']} />}>
            <Route path="/sheer-lab" element={<SheerLabPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['crm.view']} />}>
            <Route path="/crm" element={<CrmClientsPage />} />
            <Route path="/crm/clients/:id" element={<CrmClientDetailPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['rota.view']} />}>
            <Route path="/rota" element={<RotaPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['rota.manage']} />}>
            <Route path="/rota/new-week" element={<NewWeekRotaPage />} />
            <Route path="/settings/book-out-types" element={<BookOutTypesPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['services.manage']} />}>
            <Route path="/services" element={<ServiceManagementPage />}>
              <Route index element={<ServicesPage />} />
              <Route path="categories" element={<ServiceCategoriesPage />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['inventory.manage']} />}>
            <Route path="/inventory" element={<InventoryManagementPage />}>
              <Route index element={<InventoryPage />} />
              <Route path="categories" element={<InventoryCategoriesPage />} />
            </Route>
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['report.performance.view']} />}>
            <Route path="/performance" element={<PerformancePage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['report.commission.view']} />}>
            <Route path="/commission" element={<CommissionPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['staff.manage']} />}>
            <Route path="/team" element={<TeamPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['audit.read']} />}>
            <Route path="/audit-log" element={<AuditLogPage />} />
          </Route>
          <Route path="/profile" element={<ProfilePage />} />
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['settings.location.manage']} />}>
            <Route path="/locations" element={<LocationsPage />} />
            <Route path="/locations/:id" element={<LocationDetailPage />} />
            <Route path="/locations/:id/record-settings" element={<LocationRecordSettingsPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['settings.booking.manage']} />}>
            <Route path="/settings/booking" element={<BookingSettingsPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['account.manage']} />}>
            <Route path="/settings/plan" element={<AccountPlanPage />} />
          </Route>
          <Route element={<ProtectedRoute allowedRoles={['owner', 'manager']} requiredPermissions={['locations.manage']} />}>
            <Route path="/locations/new" element={<CreateLocationPage />} />
            <Route path="/locations/:id/edit" element={<EditLocationPage />} />
          </Route>
        </Route>
      </Route>
      <Route element={<ProtectedRoute allowedRoles={['owner']} />}>
        <Route element={<DashboardLayout />}>
          <Route element={<ProtectedRoute allowedRoles={['owner']} requiredPermissions={['security.manage']} />}>
            <Route path="/settings/security-levels" element={<SecurityLevelsPage />} />
          </Route>
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
