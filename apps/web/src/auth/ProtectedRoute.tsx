import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Permission, UserRole } from '@sheer/domain';
import { userHasAllPermissions, userHasAnyRole } from '@sheer/domain';
import { useAuth } from './AuthProvider';

export function ProtectedRoute({
  allowedRoles,
  requiredPermissions = [],
}: {
  allowedRoles: UserRole[];
  requiredPermissions?: Permission[];
}) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'bootstrapping') {
    return (
      <div className="grid min-h-screen place-items-center bg-bg text-text-secondary">
        Restoring your Service SaaS session...
      </div>
    );
  }

  if (!auth.user) {
    // After a sign-out, remember nothing: the next person to sign in on this
    // browser must not be sent to the previous user's page.
    return <Navigate to="/login" replace state={auth.signedOut ? undefined : { from: location }} />;
  }

  if (!userHasAnyRole(auth.user, allowedRoles)) {
    return <Navigate to="/unauthorized" replace />;
  }

  if (!userHasAllPermissions(auth.user, requiredPermissions)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <Outlet />;
}
