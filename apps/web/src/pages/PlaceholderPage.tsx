export interface PlaceholderPageProps {
  title: string;
}

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">
        This module is scaffolded but not yet implemented. Feature work will land here.
      </p>
      <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-slate-400">
        Coming soon
      </div>
    </div>
  );
}
