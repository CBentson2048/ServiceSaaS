import { formatCurrency, formatDate } from '@sheer/utils';
import { StatCard } from '../components/StatCard';

const CARDS = [
  { title: 'Bookings', description: 'Upcoming and recent appointments across locations.' },
  { title: 'CRM', description: 'Client profiles, visit history, and notes.' },
  { title: 'Rota', description: 'Staff schedules, availability, and time off.' },
  { title: 'Sheer Lab', description: 'BLE formula workflows and saved colour recipes.' },
  { title: 'Commission', description: 'Per-stylist earnings and payroll exports.' },
];

export function DashboardPage() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <p className="text-sm text-slate-500">
          {formatDate(new Date(), { dateStyle: 'full' })}
        </p>
      </div>

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          title="Revenue today"
          value={formatCurrency(0)}
          description="Connect Stripe to start tracking takings."
        />
        <StatCard
          title="Appointments"
          value="0"
          description="No bookings yet — connect a location to begin."
        />
        <StatCard
          title="Active clients"
          value="0"
          description="CRM empty. Import from existing systems when ready."
        />
      </div>

      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
        Modules
      </h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CARDS.map((card) => (
          <StatCard key={card.title} title={card.title} description={card.description} />
        ))}
      </div>
    </div>
  );
}
