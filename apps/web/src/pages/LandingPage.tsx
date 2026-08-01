import { Link, useNavigate } from 'react-router-dom';
import { AppButton, AppCard, AppText } from '../design';
import { BrandLogo } from '../components/BrandLogo';
import { sheerAppAndroidUrl, sheerAppIosUrl } from '../config/mobileApp';

const HIGHLIGHTS = [
  'Live availability from your team rota',
  'Secure deposits at the point of booking',
  'Automated WhatsApp, SMS, and email reminders',
  'One workspace for every location',
];

const AUDIENCES = [
  {
    title: 'Salon owners',
    body: 'Set up your business, invite your team, and manage services, pricing, and locations from a single dashboard.',
    cta: 'Create business account',
    href: '/owner/onboarding',
    badge: 'For owners',
    icon: <StorefrontIcon />,
  },
  {
    title: 'Managers and stylists',
    body: 'Sign in to run the day: appointments, rota and leave, client records, and performance in one place.',
    cta: 'Log in',
    href: '/login',
    badge: 'For teams',
    icon: <TeamIcon />,
  },
  {
    title: 'Clients',
    body: 'Book a real appointment in minutes. Choose your service, stylist, and a time that is genuinely available.',
    cta: 'Book an appointment',
    href: '/book/location',
    badge: 'For clients',
    icon: <CalendarIcon />,
  },
];

const FLOW_STEPS = [
  ['Choose', 'Pick a location, service, and stylist from times that reflect the live schedule.'],
  ['Confirm', 'Secure the appointment with a deposit and instant confirmation.'],
  ['Relax', 'Automatic reminders reduce no-shows before the visit.'],
];

const PREVIEW_EVENTS = [
  ['09:30', 'Full Head Colour', 'Amelia R. — deposit paid, confirmed'],
  ['11:15', 'Cut & Finish', 'James T. — reminder sent yesterday'],
  ['13:00', 'Balayage & Gloss', 'Sofia M. — booked online this morning'],
];

export function LandingPage() {
  const navigate = useNavigate();

  return (
    <main className="min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,#F0E6FF_0,#FBF9FF_34%,#F7F4FF_68%,#FDFBFF_100%)] text-text-primary">
      <div className="pointer-events-none fixed -left-24 top-20 h-72 w-72 rounded-full bg-primary/15 blur-3xl" />
      <div className="pointer-events-none fixed -right-24 top-80 h-80 w-80 rounded-full bg-surface-ink/10 blur-3xl" />

      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center justify-between px-5 py-5 lg:px-8">
        <Link to="/" aria-label="QLOOQO home" className="inline-flex items-center">
          <BrandLogo className="h-7" />
        </Link>
        <div className="flex items-center gap-2 rounded-pill border border-white/70 bg-white/65 p-1 shadow-card backdrop-blur">
          <AppButton variant="ghost" size="sm" onClick={() => navigate('/book/location')}>
            Book
          </AppButton>
          <AppButton variant="ghost" size="sm" onClick={() => navigate('/login')}>
            Log in
          </AppButton>
          <AppButton variant="secondary" size="sm" onClick={() => navigate('/owner/onboarding')}>
            Get started
          </AppButton>
        </div>
      </header>

      <section className="relative z-10 mx-auto grid w-full max-w-6xl gap-10 px-5 pb-14 pt-6 lg:grid-cols-[1.02fr_0.98fr] lg:px-8 lg:pb-24 lg:pt-14">
        <div className="flex flex-col justify-center">
          <div className="mb-5 inline-flex w-fit rounded-pill border border-primary/20 bg-white/70 px-3 py-1 text-[12px] font-medium text-primary-deep shadow-card backdrop-blur">
            Salon &amp; beauty business software
          </div>
          <AppText
            as="h1"
            variant="display"
            weight="medium"
            className="max-w-2xl text-[44px] leading-[50px] tracking-[-0.045em] text-surface-ink sm:text-[56px] sm:leading-[62px]"
          >
            Everything your salon needs to run beautifully.
          </AppText>
          <AppText
            as="p"
            variant="body"
            tone="secondary"
            className="mt-5 max-w-xl text-[16px] leading-7"
          >
            QLOOQO brings online booking, team scheduling, client records, and payments together —
            so owners stay in control, teams stay organised, and clients book in minutes.
          </AppText>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <AppButton size="lg" onClick={() => navigate('/owner/onboarding')}>
              Start your salon
            </AppButton>
            <AppButton size="lg" variant="secondary" onClick={() => navigate('/book/location')}>
              Book an appointment
            </AppButton>
          </div>
          <ul className="mt-9 grid gap-3 sm:grid-cols-2">
            {HIGHLIGHTS.map((highlight) => (
              <li key={highlight} className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 text-primary-deep">
                  <CheckIcon />
                </span>
                <span className="text-[13px] font-medium leading-5 text-text-secondary">
                  {highlight}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <AppCard
          variant="hero"
          elevation="hero"
          className="relative self-center overflow-hidden border-white/70 bg-white/85 p-0 text-text-primary backdrop-blur"
        >
          <div className="border-b border-border bg-surface-ink px-6 py-5 text-white">
            <div className="flex items-center justify-between gap-4">
              <div>
                <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/55">
                  Today · QLOOQO Studio
                </div>
                <div className="mt-1 text-[15px] font-semibold">Thursday appointment book</div>
              </div>
              <div className="shrink-0 rounded-pill bg-primary px-3 py-1 text-[11px] font-semibold text-white">
                Fully booked
              </div>
            </div>
          </div>
          <div className="p-6">
            <div className="relative space-y-3">
              <div className="absolute bottom-5 left-[25px] top-5 w-px bg-primary/15" />
              {PREVIEW_EVENTS.map(([time, title, body]) => (
                <PreviewRow key={title} time={time} title={title} body={body} />
              ))}
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <PreviewStat label="Deposits" value="Collected" />
              <PreviewStat label="Reminders" value="Scheduled" />
              <PreviewStat label="Rota" value="In sync" />
            </div>
          </div>
        </AppCard>
      </section>

      <section className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-16 lg:px-8">
        <div className="mb-6">
          <AppText
            as="h2"
            variant="title"
            weight="medium"
            className="text-[26px] leading-8 tracking-[-0.02em] text-surface-ink"
          >
            Built for everyone who walks through the door
          </AppText>
          <AppText
            as="p"
            variant="caption"
            tone="secondary"
            className="mt-2 max-w-xl text-[13px] leading-5"
          >
            One platform, three experiences — business setup, daily operations, and effortless
            client booking.
          </AppText>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {AUDIENCES.map((audience) => (
            <AppCard
              key={audience.title}
              elevation="none"
              className="group flex flex-col justify-between border-white/70 bg-white/75 p-6 shadow-card backdrop-blur transition-transform hover:-translate-y-1"
            >
              <div>
                <div className="flex items-center justify-between">
                  <span className="grid h-11 w-11 place-items-center rounded-card bg-primary/10 text-primary-deep">
                    {audience.icon}
                  </span>
                  <span className="rounded-pill border border-primary/15 bg-primary-soft px-3 py-1 text-[11px] font-medium text-primary-deep">
                    {audience.badge}
                  </span>
                </div>
                <AppText as="h3" variant="subtitle" weight="medium" className="mt-5">
                  {audience.title}
                </AppText>
                <AppText
                  as="p"
                  variant="caption"
                  tone="secondary"
                  className="mt-2 min-h-[60px] text-[13px] leading-5"
                >
                  {audience.body}
                </AppText>
              </div>
              <div className="mt-6">
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
        <div className="rounded-[32px] border border-white/70 bg-surface-ink p-6 text-white shadow-hero md:p-10">
          <div className="grid gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:items-center">
            <div>
              <div className="text-[12px] font-medium uppercase tracking-[0.18em] text-primary">
                How it works
              </div>
              <AppText
                as="h2"
                variant="title"
                weight="medium"
                className="mt-3 text-[28px] leading-9 text-white"
              >
                From first click to confirmed appointment in three steps.
              </AppText>
              <p className="mt-3 text-[13px] leading-6 text-white/60">
                Clients book against your real schedule, deposits are captured up front, and
                reminders go out automatically — no double bookings, fewer no-shows.
              </p>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              {FLOW_STEPS.map(([title, body], index) => (
                <div key={title} className="rounded-[24px] border border-white/12 bg-white/6 p-5">
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
      </section>

      <section
        id="get-the-app"
        className="relative z-10 mx-auto w-full max-w-6xl px-5 pb-20 lg:px-8"
      >
        <div className="grid items-center gap-10 rounded-[32px] border border-white/70 bg-white/75 p-7 shadow-card backdrop-blur md:p-10 lg:grid-cols-[1.05fr_0.95fr]">
          <div>
            <div className="text-[12px] font-medium uppercase tracking-[0.18em] text-primary-deep">
              QLOOQO on mobile
            </div>
            <AppText
              as="h2"
              variant="title"
              weight="medium"
              className="mt-3 max-w-md text-[28px] leading-9 tracking-[-0.02em] text-surface-ink"
            >
              Take your salon wherever the day goes.
            </AppText>
            <AppText
              as="p"
              variant="body"
              tone="secondary"
              className="mt-3 max-w-md text-[14px] leading-6"
            >
              The QLOOQO app keeps stylists on top of bookings, rota, and performance — and lets
              clients rebook their favourite stylist in a tap.
            </AppText>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <StoreBadge store="apple" href={sheerAppIosUrl} />
              <StoreBadge store="google" href={sheerAppAndroidUrl} />
            </div>
            <p className="mt-4 text-[12px] text-text-muted">Free to download · iOS and Android</p>
          </div>
          <div className="hidden justify-center lg:flex">
            <PhoneMock />
          </div>
        </div>
      </section>

      <footer className="relative z-10 border-t border-border bg-white/70 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-5 py-10 lg:px-8">
          <div className="flex flex-col justify-between gap-8 md:flex-row">
            <div className="max-w-xs">
              <BrandLogo className="h-6" />
              <p className="mt-3 text-[12px] leading-5 text-text-secondary">
                Salon software for online booking, staff scheduling, and client care — built for
                hair stylists and beauty teams.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-10 sm:grid-cols-3">
              <FooterColumn
                title="Product"
                links={[
                  ['Book an appointment', '/book/location'],
                  ['Log in', '/login'],
                  ['Create business account', '/owner/onboarding'],
                ]}
              />
              <FooterColumn
                title="Support"
                links={[
                  ['Help & support', '/support'],
                  ['Privacy policy', '/privacy-policy'],
                ]}
              />
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
                  Get the app
                </div>
                <ul className="mt-3 space-y-2">
                  <li>
                    <a
                      href={sheerAppIosUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] text-text-secondary transition-colors hover:text-primary-deep"
                    >
                      QLOOQO on the App Store
                    </a>
                  </li>
                  <li>
                    <a
                      href={sheerAppAndroidUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[13px] text-text-secondary transition-colors hover:text-primary-deep"
                    >
                      QLOOQO on Google Play
                    </a>
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div className="border-t border-border-divider pt-5 text-[11px] text-text-muted">
            © {new Date().getFullYear()} QLOOQO. All rights reserved.
          </div>
        </div>
      </footer>
    </main>
  );
}

function PreviewRow({ time, title, body }: { time: string; title: string; body: string }) {
  return (
    <div className="relative flex items-center gap-4 rounded-[20px] border border-border bg-surface-alt p-3.5">
      <div className="relative z-10 grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[14px] border border-primary/20 bg-white text-[12px] font-semibold text-primary-deep shadow-card">
        {time}
      </div>
      <div className="min-w-0">
        <div className="truncate text-[13px] font-semibold text-surface-ink">{title}</div>
        <div className="mt-0.5 truncate text-[12px] leading-5 text-text-secondary">{body}</div>
      </div>
      <span className="ml-auto hidden shrink-0 rounded-pill bg-success-soft px-2.5 py-1 text-[10px] font-semibold text-success sm:block">
        Confirmed
      </span>
    </div>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[20px] border border-border bg-white px-4 py-3 shadow-card">
      <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-text-muted">
        {label}
      </div>
      <div className="mt-1 text-[14px] font-semibold text-surface-ink">{value}</div>
    </div>
  );
}

function FooterColumn({ title, links }: { title: string; links: [string, string][] }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-text-muted">
        {title}
      </div>
      <ul className="mt-3 space-y-2">
        {links.map(([label, href]) => (
          <li key={href}>
            <Link
              to={href}
              className="text-[13px] text-text-secondary transition-colors hover:text-primary-deep"
            >
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StoreBadge({ store, href }: { store: 'apple' | 'google'; href: string }) {
  const caption = store === 'apple' ? 'Download on the' : 'Get it on';
  const name = store === 'apple' ? 'App Store' : 'Google Play';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${caption} ${name}`}
      className="inline-flex items-center gap-3 rounded-[14px] bg-surface-ink px-5 py-2.5 text-white shadow-card transition-all hover:-translate-y-0.5 hover:bg-surface-ink-deep"
    >
      {store === 'apple' ? <AppleIcon /> : <PlayIcon />}
      <span className="flex flex-col text-left leading-none">
        <span className="text-[10px] font-medium text-white/70">{caption}</span>
        <span className="mt-1 text-[15px] font-semibold tracking-tight">{name}</span>
      </span>
    </a>
  );
}

function PhoneMock() {
  return (
    <div className="w-[250px] rounded-[38px] border border-border-strong bg-surface-ink p-2.5 shadow-hero">
      <div className="overflow-hidden rounded-[30px] bg-bg">
        <div className="bg-surface-ink px-5 pb-5 pt-6 text-white">
          <div className="text-[10px] font-medium uppercase tracking-[0.16em] text-white/50">
            Good morning
          </div>
          <div className="mt-1 text-[16px] font-semibold">Amelia&rsquo;s day at a glance</div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <div className="rounded-[14px] bg-white/10 px-3 py-2.5">
              <div className="text-[9px] uppercase tracking-[0.12em] text-white/50">Bookings</div>
              <div className="mt-0.5 text-[15px] font-semibold">8</div>
            </div>
            <div className="rounded-[14px] bg-white/10 px-3 py-2.5">
              <div className="text-[9px] uppercase tracking-[0.12em] text-white/50">Rebooked</div>
              <div className="mt-0.5 text-[15px] font-semibold">86%</div>
            </div>
          </div>
        </div>
        <div className="space-y-2 p-4">
          {[
            ['09:30', 'Full Head Colour'],
            ['11:15', 'Cut & Finish'],
            ['13:00', 'Balayage & Gloss'],
          ].map(([time, service]) => (
            <div
              key={time}
              className="flex items-center gap-3 rounded-[14px] border border-border bg-white px-3 py-2.5 shadow-card"
            >
              <span className="text-[11px] font-semibold text-primary-deep">{time}</span>
              <span className="truncate text-[12px] font-medium text-surface-ink">{service}</span>
            </div>
          ))}
          <div className="rounded-[14px] bg-primary px-3 py-2.5 text-center text-[12px] font-semibold text-white">
            View full schedule
          </div>
        </div>
      </div>
    </div>
  );
}

function AppleIcon() {
  return (
    <svg width="20" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8.79.06 2.26-.98 3.81-.84 1.86.15 3.27.88 4.19 2.26-3.72 2.23-3.12 7.14.34 8.53-.7 1.52-1.61 3.02-3.42 4.22ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="19" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M1.57 23.66 12.1 13.16l3.71 3.7-12.52 6.94c-.47.27-1.06.26-1.53-.01l-.19-.13ZM11.04 12.1 1 22.11V2.09L11.04 12.1Zm6.27-4.13 4.91 2.72c.48.27.78.77.78 1.31s-.3 1.05-.78 1.32l-4.91 2.72-4-3.99 4-4.08ZM1.46.43c.09-.09.19-.16.3-.23.47-.27 1.06-.27 1.53-.01l12.66 7.01-3.85 3.91L1.46.43Z" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 12.5 9.5 17 19 7.5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function StorefrontIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 9.5 5.2 4h13.6L20 9.5M4 9.5a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0M5 12v8h14v-8M9.5 20v-5h5v5"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function TeamIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9 11.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5ZM3.5 19.5c.6-3 2.8-4.75 5.5-4.75s4.9 1.75 5.5 4.75M15.5 5.4a3.25 3.25 0 0 1 0 5.7M17.6 15c1.5.65 2.55 1.95 2.9 4"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 3.5v3M17 3.5v3M4 8.5h16M5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5ZM9 13.5l2.2 2.2L15.5 11"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
