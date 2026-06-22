import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export function UnauthorizedPage() {
  const { signOut, user } = useAuth();

  return (
    <main className="grid min-h-screen place-items-center bg-bg px-4">
      <section className="max-w-md rounded-card-lg border border-border bg-surface p-8 text-center shadow-sm">
        <h1 className="text-2xl font-semibold text-text-primary">Access not available</h1>
        <p className="mt-2 text-sm text-text-secondary">
          {user?.primaryRole
            ? `The ${user.primaryRole} role is not enabled for this web dashboard phase.`
            : 'Sign in with an owner or manager account to continue.'}
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link className="rounded-input-lg bg-primary px-4 py-2 text-sm font-semibold text-white" to="/">
            Dashboard
          </Link>
          <button
            className="rounded-input-lg border border-border-strong px-4 py-2 text-sm font-semibold text-text-primary"
            type="button"
            onClick={() => void signOut()}
          >
            Sign out
          </button>
        </div>
      </section>
    </main>
  );
}
