import { cn } from '@sheer/utils';

export interface StatCardProps {
  title: string;
  description: string;
  value?: string;
  className?: string;
}

export function StatCard({ title, description, value, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition-shadow hover:shadow-md',
        className,
      )}
    >
      <div className="text-sm font-medium text-slate-500">{title}</div>
      {value ? (
        <div className="mt-2 text-2xl font-semibold text-slate-900">{value}</div>
      ) : (
        <div className="mt-2 text-2xl font-semibold text-slate-300">—</div>
      )}
      <p className="mt-2 text-sm text-slate-500">{description}</p>
    </div>
  );
}
