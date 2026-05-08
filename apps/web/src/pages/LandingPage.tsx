import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppButton, AppCard, AppText } from '../design';

const AUDIENCES = [
  {
    title: 'Business owners',
    body: 'Launch your salon workspace, invite your team, manage locations, and keep rota-backed bookings in one place.',
    cta: 'Create business account',
    href: '/owner/onboarding',
    image:
      'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=900&q=80',
    imageAlt: 'Hair stylist and client reviewing hair colour options in a salon',
  },
  {
    title: 'Managers and employees',
    body: 'Sign in to manage schedules, view your week, and keep the salon running from the right product surface.',
    cta: 'Log in',
    href: '/login',
    image:
      'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=900&q=80',
    imageAlt: 'Stylist using a straightener during a salon appointment',
  },
  {
    title: 'Customers',
    body: 'Book real services from real rota availability. Pick a service, stylist, time, and confirm in the browser.',
    cta: 'Book a service',
    href: '/book/location',
    image:
      'https://images.unsplash.com/photo-1562322140-8baeececf3df?auto=format&fit=crop&w=900&q=80',
    imageAlt: 'Client smiling during a hair appointment with a stylist',
  },
];

const FEATURES = [
  'Rota-driven availability',
  'Service durations from live data',
  'Client accounts and preferences',
  'Deposit-ready booking flow',
];

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <main className="min-h-screen bg-[#f7f4ff] text-text-primary">
      <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 lg:px-8">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="text-[18px] font-semibold tracking-tight text-[#1C1628]"
        >
          Sheer
        </button>
        <div className="flex items-center gap-2">
          <AppButton variant="ghost" size="sm" onClick={() => navigate('/book/location')}>
            Book
          </AppButton>
          <AppButton variant="secondary" size="sm" onClick={() => navigate('/login')}>
            Log in
          </AppButton>
        </div>
      </header>

      <section className="mx-auto grid w-full max-w-6xl gap-6 px-5 pb-10 pt-4 lg:grid-cols-[1.05fr_0.95fr] lg:px-8 lg:pb-16 lg:pt-10">
        <div className="flex flex-col justify-center">
          <div className="mb-4 inline-flex w-fit rounded-pill border border-primary/20 bg-primary/8 px-3 py-1 text-[12px] font-medium text-primary">
            Salon booking, rota, and client flow
          </div>
          <AppText as="h1" variant="display" weight="medium" className="max-w-2xl text-[40px] leading-[46px] text-[#1C1628]">
            Book services, run rotas, and bring every salon visit into one flow.
          </AppText>
          <AppText as="p" variant="body" tone="secondary" className="mt-4 max-w-xl text-[15px] leading-6">
            Sheer helps owners, managers, stylists, and clients move from scheduling to booking without fake availability or unnecessary app installs.
          </AppText>
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <AppButton size="lg" onClick={() => navigate('/owner/onboarding')}>
              Start your salon
            </AppButton>
            <AppButton size="lg" variant="secondary" onClick={() => navigate('/book/location')}>
              Book an appointment
            </AppButton>
          </div>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div key={feature} className="rounded-input-lg border border-border bg-surface/70 px-3 py-2 text-[12px] text-text-secondary">
                {feature}
              </div>
            ))}
          </div>
        </div>

        <AppCard variant="hero" elevation="hero" className="overflow-hidden border-primary/15 bg-[#1C1628] p-0 text-white">
          <div className="relative h-72 overflow-hidden">
            <LandingImage
              src="https://plus.unsplash.com/premium_photo-1661963614908-4b97a107b2ae?auto=format&fit=crop&w=1200&q=80"
              alt="Hair stylist blow drying a client's hair during a salon appointment"
              className="h-full w-full object-cover opacity-85"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#1C1628] via-[#1C1628]/35 to-transparent" />
            <div className="absolute bottom-4 left-4 right-4">
              <div className="rounded-card border border-white/15 bg-[#1C1628]/70 px-4 py-3 backdrop-blur">
                <div className="text-[13px] font-semibold">Booking that follows the rota</div>
                <div className="mt-1 text-[12px] text-white/65">
                  Clients choose real available times while teams keep schedule control.
                </div>
              </div>
            </div>
          </div>
          <div className="border-b border-white/10 px-5 py-4">
            <div className="text-[13px] font-semibold">Today at Sheer Studio</div>
            <div className="mt-1 text-[12px] text-white/60">Live booking journey preview</div>
          </div>
          <div className="space-y-3 p-5">
            <PreviewRow label="Client" value="Chooses colour service" />
            <PreviewRow label="Availability" value="Checked against rota, breaks, leave, and appointments" />
            <PreviewRow label="Account" value="Signs in or creates account in browser" />
            <PreviewRow label="Confirmation" value="Preference saved, deposit scaffold ready" />
          </div>
        </AppCard>
      </section>

      <section className="mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <div className="mb-4">
          <AppText as="h2" variant="title" weight="medium">
            Choose where you want to start
          </AppText>
          <AppText as="p" variant="caption" tone="secondary" className="mt-1">
            Built for business setup, staff access, and client booking from the same platform.
          </AppText>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {AUDIENCES.map((audience) => (
            <AppCard key={audience.title} elevation="none" className="flex min-h-[220px] flex-col justify-between">
              <div>
                <div className="mb-4 overflow-hidden rounded-card border border-border bg-surface-alt">
                  <LandingImage
                    src={audience.image}
                    alt={audience.imageAlt}
                    className="h-36 w-full object-cover"
                    loading="lazy"
                  />
                </div>
                <AppText as="h3" variant="subtitle" weight="medium">
                  {audience.title}
                </AppText>
                <AppText as="p" variant="caption" tone="secondary" className="mt-3 leading-5">
                  {audience.body}
                </AppText>
              </div>
              <AppButton className="mt-5" fullWidth variant={audience.href === '/book/location' ? 'primary' : 'secondary'} onClick={() => navigate(audience.href)}>
                {audience.cta}
              </AppButton>
            </AppCard>
          ))}
        </div>
        <p className="mt-4 text-[11px] text-text-muted">
          Photography sourced from online stock image services for visual context only.
        </p>
      </section>
    </main>
  );
}

function PreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-card border border-white/10 bg-white/6 px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.08em] text-white/45">{label}</div>
      <div className="mt-1 text-[13px] font-medium text-white">{value}</div>
    </div>
  );
}

function LandingImage({
  src,
  alt,
  className,
  loading,
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
}) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className={`flex items-center justify-center bg-gradient-to-br from-primary/20 via-[#F1E9FF] to-[#1C1628]/20 ${className ?? ''}`}>
        <span className="px-4 text-center text-[12px] font-medium text-text-secondary">
          Salon booking experience
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
