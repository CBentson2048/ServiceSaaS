import type { FormEvent} from 'react';
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider';

export function CreateAccountPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [fullName, setFullName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (auth.user) {
    return <Navigate to="/" replace />;
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      await auth.createAccount({ email, password, fullName, businessName });
      navigate('/', { replace: true });
    } catch {
      setError('Account creation failed. Check the details or use a different email.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#F7F2EA] px-4 py-8 text-text-primary">
      <section className="w-full max-w-md overflow-hidden rounded-[28px] border border-[#E7DCCF] bg-white shadow-[0_24px_80px_rgba(38,28,52,0.12)]">
        <div className="border-b border-[#EFE6DC] bg-[#FBF7F1] px-8 py-7 text-center">
          <div className="mb-6 text-sm font-semibold tracking-[0.38em] text-[#2F2540]">
            SH<span className="text-primary">EE</span>R
          </div>
          <h1 className="text-2xl font-semibold text-[#241E30]">Create your account</h1>
          <p className="mt-1 text-sm text-[#776A82]">
            Start as the owner of a new Sheer business workspace.
          </p>
        </div>

        <form className="space-y-4 px-8 py-7" onSubmit={onSubmit}>
          <Field label="Full name" value={fullName} onChange={setFullName} autoComplete="name" />
          <Field label="Business name" value={businessName} onChange={setBusinessName} />
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
          <Field
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete="new-password"
          />

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
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </button>

          <p className="text-center text-sm text-[#776A82]">
            Already have an account?{' '}
            <Link className="font-semibold text-primary-deep" to="/login">
              Sign in
            </Link>
          </p>
        </form>
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold uppercase tracking-[0.16em] text-[#8A7D94]">
        {label}
      </span>
      <input
        className="mt-2 w-full rounded-input-lg border border-[#E5D9CC] bg-[#FFFCF8] px-4 py-3 text-sm outline-none transition focus:border-primary"
        type={type}
        autoComplete={autoComplete}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required
      />
    </label>
  );
}
