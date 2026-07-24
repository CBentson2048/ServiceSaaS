import { useAuth } from '../auth/AuthProvider';
import { PlanCard } from '../components/account/PlanCard';

/**
 * Settings → Account & plan. Hosts the plan/upgrade card so it stays reachable
 * on single-column tiers where the Locations screen is hidden from the nav
 * (Wrike 4507281247). Route is gated by the `account.manage` permission.
 */
export function AccountPlanPage() {
  const auth = useAuth();
  const accessToken = auth.session?.accessToken;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 lg:px-8">
      <header className="mb-6">
        <h1 className="text-[22px] font-semibold leading-7 text-text-primary">Your plan</h1>
        <p className="mt-1 text-[13px] text-text-secondary">
          See what&apos;s included, keep an eye on your usage, and upgrade the moment your business
          is ready for more.
        </p>
      </header>

      {accessToken ? <PlanCard accessToken={accessToken} /> : null}
    </div>
  );
}
