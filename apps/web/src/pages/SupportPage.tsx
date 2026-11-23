import { type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppCard, AppText } from '../design';
import { usePageMetadata } from '../hooks/usePageMetadata';

/**
 * Public support page (App Store Guideline 1.5 — Support URL).
 *
 * This is the URL submitted in App Store Connect as the app's Support link
 * (https://qlooqo.com/support). It is mounted OUTSIDE the dashboard
 * ProtectedRoute so it is reachable without any session — exactly like the
 * privacy-policy and account-deletion pages it sits next to — and gives App
 * Store reviewers and customers a clear, real way to get help.
 */

const SUPPORT_EMAIL = 'support@qlooqo.com';

const PAGE_TITLE = 'Service SaaS Support';
const PAGE_DESCRIPTION =
  'Contact Service SaaS support for help with bookings, accounts, payments, privacy, and app support.';

const SUPPORT_TOPICS = [
  'Booking or appointment issues',
  'Account login or profile help',
  'Payment or deposit questions',
  'Salon or stylist information',
  'Notifications by email, SMS, or WhatsApp',
  'App bugs or technical issues',
  'Account deletion or privacy requests',
];

export function SupportPage() {
  usePageMetadata(PAGE_TITLE, PAGE_DESCRIPTION);

  return (
    <main className="min-h-screen bg-bg px-4 py-10 text-text-primary sm:py-14">
      <AppCard elevation="hero" padding="lg" className="mx-auto w-full max-w-3xl">
        <header className="mb-8 text-center">
          <div
            aria-hidden="true"
            className="mb-4 text-xs font-semibold tracking-[0.38em] text-text-secondary"
          >
            QL<span className="text-primary">OO</span>QO
          </div>
          <AppText as="h1" variant="heading" weight="medium">
            Service SaaS Support
          </AppText>
          <AppText
            as="p"
            variant="body"
            tone="secondary"
            className="mx-auto mt-3 max-w-xl leading-7"
          >
            Need help with your booking, account, or app experience? We&rsquo;re here to help.
          </AppText>
        </header>

        <div className="space-y-8">
          <Section title="Contact support">
            <Paragraph>
              Our team can help with booking issues, account access, payment and deposit questions,
              appointment changes, notifications, or any technical problems you run into. Send us an
              email with a short description of what you need and, if it helps, the name of the
              salon or appointment involved.
            </Paragraph>

            <div className="rounded-input-lg border border-border bg-surface-alt px-5 py-4">
              <AppText
                as="p"
                variant="caption"
                tone="muted"
                className="font-semibold uppercase tracking-[0.14em]"
              >
                Email our support team
              </AppText>
              <a
                href={`mailto:${SUPPORT_EMAIL}`}
                className="mt-1 inline-block text-[18px] font-semibold text-primary-deep hover:underline"
              >
                {SUPPORT_EMAIL}
              </a>
            </div>
          </Section>

          <Section title="Response time">
            <div className="rounded-input-lg border border-border bg-surface-alt px-5 py-4">
              <Paragraph>
                We aim to respond to support requests within 1&ndash;2 business days.
              </Paragraph>
            </div>
          </Section>

          <Section title="Common support topics">
            <BulletList items={SUPPORT_TOPICS} />
          </Section>

          <Section title="Account &amp; data">
            <Paragraph>
              You can review how we handle your information, or remove your account, at any time:
            </Paragraph>
            <BulletList
              items={[
                <>
                  <Link
                    to="/privacy-policy"
                    className="font-medium text-primary-deep hover:underline"
                  >
                    Privacy Policy
                  </Link>{' '}
                  &mdash; how we collect, use, and protect your personal information.
                </>,
                <>
                  <Link
                    to="/delete-account"
                    className="font-medium text-primary-deep hover:underline"
                  >
                    Delete your account
                  </Link>{' '}
                  &mdash; permanently remove your account and personal profile.
                </>,
              ]}
            />
          </Section>
        </div>

        <footer className="mt-10 border-t border-border pt-6 text-center">
          <div
            aria-hidden="true"
            className="text-xs font-semibold tracking-[0.38em] text-text-secondary"
          >
            QL<span className="text-primary">OO</span>QO
          </div>
          <AppText
            as="p"
            variant="caption"
            tone="muted"
            className="mx-auto mt-3 max-w-md leading-6"
          >
            Service SaaS helps customers book and manage salon and beauty appointments.
          </AppText>
          <Link
            to="/"
            className="mt-4 inline-block text-[13px] font-medium text-primary-deep hover:underline"
          >
            Back to home
          </Link>
        </footer>
      </AppCard>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <AppText as="h2" variant="subtitle" weight="medium">
        {title}
      </AppText>
      {children}
    </section>
  );
}

function Paragraph({ children }: { children: ReactNode }) {
  return (
    <AppText as="p" variant="body" tone="secondary" className="leading-7">
      {children}
    </AppText>
  );
}

function BulletList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="list-disc space-y-2 pl-5 text-[14px] leading-7 text-text-secondary">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
