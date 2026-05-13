import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppButton, AppCard, AppText } from '../design';

const AUDIENCES = [
  {
    title: 'Business owners',
    body: 'Launch your salon workspace, invite your team, manage locations, and keep rota-backed bookings in one place.',
    cta: 'Create business account',
    href: '/owner/onboarding',
    badge: 'Setup',
    image:
      'https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&w=900&q=80',
    imageAlt: 'Hair stylist and client reviewing hair colour options in a salon',
  },
  {
    title: 'Managers and employees',
    body: 'Sign in to manage schedules, view your week, and keep the salon running from the right product surface.',
    cta: 'Log in',
    href: '/login',
    badge: 'Operations',
    image:
      'https://images.unsplash.com/photo-1522337360788-8b13dee7a37e?auto=format&fit=crop&w=900&q=80',
    imageAlt: 'Stylist using a straightener during a salon appointment',
  },
  {
    title: 'Customers',
    body: 'Book real services from real rota availability. Pick a service, stylist, time, and confirm in the browser.',
    cta: 'Book a service',
    href: '/book/location',
    badge: 'Booking',
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

const STATS = [
  ['6', 'step booking flow'],
  ['Live', 'rota availability'],
  ['3', 'product surfaces'],
];

const FLOW_STEPS = [
  ['Choose', 'Pick a location, service, stylist, and real appointment time.'],
  ['Confirm', 'Create or sign in to a client account and pay the required deposit.'],
  ['Return', 'Use the Sheer App recommendation after booking for future visits.'],
];

const PREVIEW_EVENTS = [
  ['01', 'Service selected', 'Full Head Colour with rota-backed duration'],
  ['02', 'Availability checked', 'Breaks, leave, and appointments already excluded'],
  ['03', 'Client confirmed', 'Account, contact preference, and deposit captured'],
];

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#F0E6FF_0,#FBF9FF_34%,#F7F4FF_68%,#FDFBFF_100%)] text-text-primary">
      <div className="pointer-events-none fixed -left-24 top-20 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none fixed -right-24 top-80 h-80 w-80 rounded-full bg-[#1C1628]/10 blur-3xl" />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 lg:px-8">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="inline-flex items-center gap-2 text-[18px] font-semibold tracking-tight text-[#1C1628]"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-[#1C1628] text-[13px] text-white">
            Sh
          </span>
          <span>Sheer</span>
        </button>
        <div className="flex items-center gap-2 rounded-pill border border-white/70 bg-white/65 p-1 shadow-card backdrop-blur">
          <AppButton variant="ghost" size="sm" onClick={() => navigate('/book/location')}>
            Book
          </AppButton>
          <AppButton variant="secondary" size="sm" onClick={() => navigate('/login')}>
            Log in
          </AppButton>
        </div>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-6xl gap-8 px-5 pb-12 pt-5 lg:grid-cols-[1.02fr_0.98fr] lg:px-8 lg:pb-20 lg:pt-12">
        <div className="flex flex-col justify-center">
          <div className="mb-5 inline-flex w-fit rounded-pill border border-primary/20 bg-white/70 px-3 py-1 text-[12px] font-medium text-primary shadow-card backdrop-blur">
            Salon booking, rota, and client flow
          </div>
          <AppText
            as="h1"
            variant="display"
            weight="medium"
            className="max-w-2xl text-[46px] leading-[50px] tracking-[-0.045em] text-[#1C1628] sm:text-[58px] sm:leading-[62px]"
          >
            One calm flow for booking and running a salon.
          </AppText>
          <AppText
            as="p"
            variant="body"
            tone="secondary"
            className="mt-5 max-w-xl text-[16px] leading-7"
          >
            Sheer connects owner setup, rota-backed availability, client booking, and app follow-up without forcing customers through an install before they confirm.
          </AppText>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <AppButton size="lg" onClick={() => navigate('/owner/onboarding')}>
              Start your salon
            </AppButton>
            <AppButton size="lg" variant="secondary" onClick={() => navigate('/book/location')}>
              Book an appointment
            </AppButton>
          </div>
          <div className="mt-8 grid gap-3 sm:grid-cols-2">
            {FEATURES.map((feature) => (
              <div
                key={feature}
                className="rounded-card border border-white/70 bg-white/65 px-4 py-3 text-[12px] font-medium text-text-secondary shadow-card backdrop-blur"
              >
                {feature}
              </div>
            ))}
          </div>
          <div className="mt-8 grid max-w-lg grid-cols-3 gap-3">
            {STATS.map(([value, label]) => (
              <div key={label} className="rounded-card border border-primary/10 bg-primary/5 px-3 py-3">
                <div className="text-[20px] font-semibold leading-6 text-[#1C1628]">{value}</div>
                <div className="mt-1 text-[11px] leading-4 text-text-secondary">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <AppCard
          variant="hero"
          elevation="hero"
          className="relative overflow-hidden border-white/70 bg-white/80 p-0 text-text-primary backdrop-blur"
        >
          <div className="absolute right-6 top-6 z-10 rounded-pill border border-white/15 bg-white/10 px-3 py-1 text-[11px] font-medium text-white/75 backdrop-blur">
            Live journey preview
          </div>
          <div className="relative h-80 overflow-hidden">
            <LandingImage
              src="https://plus.unsplash.com/premium_photo-1661963614908-4b97a107b2ae?auto=format&fit=crop&w=1200&q=80"
              alt="Hair stylist blow drying a client's hair during a salon appointment"
              className="h-full w-full object-cover opacity-85"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-[#1C1628] via-[#1C1628]/35 to-transparent" />
            <div className="absolute bottom-4 left-4 right-4">
              <div className="rounded-[24px] border border-white/15 bg-[#1C1628]/70 px-5 py-4 backdrop-blur">
                <div className="text-[15px] font-semibold">Booking that follows the rota</div>
                <div className="mt-1 max-w-sm text-[12px] leading-5 text-white/65">
                  Clients choose real available times while teams keep schedule control.
                </div>
              </div>
            </div>
          </div>
          <div className="border-b border-border bg-white px-6 py-5">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[13px] font-semibold text-[#1C1628]">Today at Sheer Studio</div>
                <div className="mt-1 text-[12px] leading-5 text-text-secondary">
                  A confirmed colour appointment from live availability.
                </div>
              </div>
              <div className="shrink-0 rounded-pill bg-primary px-3 py-1 text-[11px] font-semibold text-white">
                Confirmed
              </div>
            </div>
          </div>
          <div className="p-6">
            <div className="rounded-[26px] border border-border bg-white p-4 shadow-card">
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-text-muted">
                    Appointment flow
                  </div>
                  <div className="mt-1 text-[13px] font-semibold text-[#1C1628]">
                    Public booking completed
                  </div>
                </div>
                <div className="w-fit rounded-pill border border-primary/30 bg-primary/10 px-3 py-1 text-[11px] font-semibold text-primary">
                  Step 6 of 6
                </div>
              </div>
              <div className="relative space-y-3">
                <div className="absolute bottom-5 left-[17px] top-5 w-px bg-primary/15" />
                {PREVIEW_EVENTS.map(([index, title, body]) => (
                  <PreviewRow key={title} index={index} title={title} body={body} />
                ))}
              </div>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div className="rounded-[22px] border border-border bg-white px-4 py-3 shadow-card">
                <div className="text-[11px] uppercase tracking-[0.12em] text-text-muted">Deposit</div>
                <div className="mt-1 text-[16px] font-semibold text-[#1C1628]">Paid</div>
              </div>
              <div className="rounded-[22px] border border-border bg-white px-4 py-3 shadow-card">
                <div className="text-[11px] uppercase tracking-[0.12em] text-text-muted">Next action</div>
                <div className="mt-1 text-[16px] font-semibold text-[#1C1628]">Open app</div>
              </div>
            </div>
          </div>
        </AppCard>
      </section>

      <section className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <div className="mb-5 flex flex-col justify-between gap-3 md:flex-row md:items-end">
          <div>
            <AppText as="h2" variant="title" weight="medium" className="text-[26px] leading-8 tracking-[-0.02em] text-[#1C1628]">
            Choose where you want to start
            </AppText>
            <AppText as="p" variant="caption" tone="secondary" className="mt-2 max-w-xl text-[13px] leading-5">
              Built for business setup, staff access, and client booking from the same platform.
            </AppText>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {AUDIENCES.map((audience) => (
            <AppCard
              key={audience.title}
              elevation="none"
              className="group flex min-h-[300px] flex-col justify-between overflow-hidden border-white/70 bg-white/70 p-0 shadow-card backdrop-blur transition-transform hover:-translate-y-1"
            >
              <div>
                <div className="relative overflow-hidden border-b border-border bg-surface-alt">
                  <LandingImage
                    src={audience.image}
                    alt={audience.imageAlt}
                    className="h-44 w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                    loading="lazy"
                  />
                  <div className="absolute left-4 top-4 rounded-pill border border-white/40 bg-white/75 px-3 py-1 text-[11px] font-medium text-[#1C1628] backdrop-blur">
                    {audience.badge}
                  </div>
                </div>
                <div className="p-5">
                  <AppText as="h3" variant="subtitle" weight="medium">
                    {audience.title}
                  </AppText>
                  <AppText as="p" variant="caption" tone="secondary" className="mt-3 min-h-[48px] leading-5">
                    {audience.body}
                  </AppText>
                </div>
              </div>
              <div className="px-5 pb-5">
                <AppButton
                  fullWidth
                  variant={audience.href === '/book/location' ? 'primary' : 'secondary'}
                  onClick={() => navigate(audience.href)}
                >
                  {audience.cta}
                </AppButton>
              </div>
            </AppCard>
          ))}
        </div>
      </section>

      <section className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-20 lg:px-8">
        <div className="rounded-[32px] border border-white/70 bg-[#1C1628] p-6 text-white shadow-hero md:p-8">
          <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
            <div>
              <div className="text-[12px] font-medium uppercase tracking-[0.18em] text-primary">
                How it works
              </div>
              <AppText as="h2" variant="title" weight="medium" className="mt-3 text-[28px] leading-9 text-white">
                From public booking to app follow-up, every step has a clear job.
              </AppText>
              <p className="mt-3 text-[13px] leading-6 text-white/60">
                The web experience gets the appointment confirmed first. The app recommendation appears only after the client has completed booking.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {FLOW_STEPS.map(([title, body], index) => (
                <div key={title} className="rounded-[24px] border border-white/12 bg-white/6 p-4">
                  <div className="mb-4 grid h-8 w-8 place-items-center rounded-full bg-primary text-[12px] font-semibold">
                    {index + 1}
                  </div>
                  <div className="text-[14px] font-semibold">{title}</div>
                  <div className="mt-2 text-[12px] leading-5 text-white/60">{body}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <p className="mt-4 text-[11px] text-text-muted">
          Photography sourced from online stock image services for visual context only.
        </p>
      </section>
    </main>
  );
}

function PreviewRow({
  index,
  title,
  body,
}: {
  index: string;
  title: string;
  body: string;
}) {
  return (
    <div className="relative flex gap-3 rounded-[20px] border border-border bg-[#FBF9FF] p-3 shadow-[0_10px_24px_rgba(28,22,40,0.08)]">
      <div className="relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/25 bg-primary/10 text-[11px] font-semibold text-primary">
        {index}
      </div>
      <div className="min-w-0">
        <div className="break-words text-[13px] font-semibold text-[#1C1628]">{title}</div>
        <div className="mt-1 break-words text-[12px] leading-5 text-text-secondary">{body}</div>
      </div>
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
