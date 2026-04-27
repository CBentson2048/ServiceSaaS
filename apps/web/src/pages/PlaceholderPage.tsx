import { AppCard, AppText } from '../design';

export interface PlaceholderPageProps {
  title: string;
}

export function PlaceholderPage({ title }: PlaceholderPageProps) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 lg:px-8">
      <AppText as="h1" variant="heading" weight="medium">
        {title}
      </AppText>
      <AppText as="p" variant="caption" tone="secondary" className="mt-2">
        This module is scaffolded but not yet implemented. Feature work will land here.
      </AppText>
      <AppCard
        elevation="none"
        padding="lg"
        className="mt-6 border-dashed text-center"
      >
        <AppText tone="muted">Coming soon</AppText>
      </AppCard>
    </div>
  );
}
