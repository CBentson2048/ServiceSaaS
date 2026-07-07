import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { UserRole } from '@sheer/domain';
import { userHasAnyRole } from '@sheer/domain';
import { useAuth } from './AuthProvider';

export function ProtectedRoute({ allowedRoles }: { allowedRoles: UserRole[] }) {
  const auth = useAuth();
  const location = useLocation();

  if (auth.status === 'bootstrapping') {
    return (
      <div className="grid min-h-screen place-items-center bg-bg text-text-secondary">
        Restoring your Qlooqo session...
      </div>
    );
  }

  if (!auth.user) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (!userHasAnyRole(auth.user, allowedRoles)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <Outlet />;
}
