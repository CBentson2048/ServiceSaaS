import { FormEvent, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const from = (location.state as { from?: { pathname?: string } } | null)?.from?.pathname ?? '/';

  if (auth.user) {
    return <Navigate to={from} replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await auth.signIn(email, password);
      navigate(from, { replace: true });
    } catch {
      setError('Sign in failed. Check the account role, email, and password.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#F7F2EA] px-4 text-text-primary">
      <section className="w-full max-w-md overflow-hidden rounded-[28px] border border-[#E7DCCF] bg-white shadow-[0_24px_80px_rgba(38,28,52,0.12)]">
        <div className="border-b border-[#EFE6DC] bg-[#FBF7F1] px-8 py-7 text-center">
          <div className="mb-6 text-sm font-semibold tracking-[0.38em] text-[#2F2540]">
            SH<span className="text-primary">EE</span>R
          </div>
          <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-full border border-primary/30 bg-primary/10 text-primary">
            <span aria-hidden>◇</span>
          </div>
          <h1 className="text-2xl font-semibold text-[#241E30]">Welcome back</h1>
          <p className="mt-1 text-sm text-[#776A82]">Owner and manager dashboard access</p>
        </div>

        <form className="space-y-4 px-8 py-7" onSubmit={onSubmit}>
          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
              Email
            </span>
            <input
              className="mt-2 w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>

          <label className="block">
            <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
              Password
            </span>
            <input
              className="mt-2 w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>

          {error ? (
            <div className="rounded-input-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full rounded-input-lg bg-primary px-4 py-3 text-sm font-semibold text-white transition hover:bg-primary-deep disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSubmitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
