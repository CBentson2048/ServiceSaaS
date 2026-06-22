import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppCard, AppText } from '../design';

/**
 * Public privacy policy page.
 *
 * This is the URL submitted in App Store Connect as the app's Privacy Policy
 * link (https://qlooqo.com/privacy-policy). It is mounted OUTSIDE the dashboard
 * ProtectedRoute so it is reachable without any session, exactly like the
 * account-deletion page it sits next to.
 *
 * Content describes the data the qlooqo salon-booking app collects (Contact
 * Info, Purchases, Usage Data — the categories declared on the App Privacy
 * card) and a user's rights over it.
 */

const LAST_UPDATED = '22 June 2026';
const CONTACT_EMAIL = 'privacy@qlooqo.com';

export function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-bg px-4 py-10 text-text-primary sm:py-14">
      <AppCard elevation="hero" padding="lg" className="mx-auto w-full max-w-3xl">
        <header className="mb-8 text-center">
          <div className="mb-4 text-xs font-semibold tracking-[0.38em] text-text-secondary">
            SH<span className="text-primary">EE</span>R
          </div>
          <AppText as="h1" variant="heading" weight="medium">
            Privacy Policy
          </AppText>
          <AppText as="p" variant="caption" tone="muted" className="mt-2">
            Last updated: {LAST_UPDATED}
          </AppText>
        </header>

        <div className="space-y-8">
          <Section>
            <Paragraph>
              This policy explains how the qlooqo app and website (&ldquo;qlooqo&rdquo;,
              &ldquo;we&rdquo;, &ldquo;us&rdquo;) collect and use your personal information when you
              book salon appointments, manage your account, and use related features. By using
              qlooqo you agree to the practices described here.
            </Paragraph>
            <Paragraph>
              When you book with a salon, that salon is the controller of your appointment and
              client records and uses your information to provide its services. qlooqo provides the
              software that the salon uses to run those bookings.
            </Paragraph>
          </Section>

          <Section title="Information we collect">
            <BulletList
              items={[
                <>
                  <Strong>Contact information</Strong> — your name, email address, and phone number,
                  which you provide when you create an account or make a booking.
                </>,
                <>
                  <Strong>Account and profile details</Strong> — your sign-in credentials and any
                  preferences you choose to save (for example, a preferred stylist or location).
                </>,
                <>
                  <Strong>Booking and service history</Strong> — the appointments you book, the
                  services and stylists you select, and notes related to your visits.
                </>,
                <>
                  <Strong>Purchases</Strong> — records of deposits and payments you make, including
                  the amount and status. Card details are handled by our payment provider and are
                  not stored by qlooqo.
                </>,
                <>
                  <Strong>Usage data</Strong> — basic technical information about how you interact
                  with the app, such as device type and app activity, used to keep the service
                  working and improve it.
                </>,
              ]}
            />
          </Section>

          <Section title="How we use your information">
            <BulletList
              items={[
                'Create and manage your account and verify it is you.',
                'Take bookings, confirm appointments, and process deposits and payments.',
                'Send booking confirmations, reminders, and other messages about your appointments.',
                'Provide your booking information to the salon you book with so it can serve you.',
                'Keep the service secure, troubleshoot problems, and improve how qlooqo works.',
                'Meet our legal, tax, and accounting obligations.',
              ]}
            />
          </Section>

          <Section title="How we share your information">
            <Paragraph>We do not sell your personal information. We share it only:</Paragraph>
            <BulletList
              items={[
                <>
                  with the <Strong>salon you book with</Strong>, so it can manage your appointment
                  and client record;
                </>,
                <>
                  with <Strong>service providers</Strong> that operate qlooqo on our behalf — such
                  as hosting, payment processing, and message delivery (email, SMS, and WhatsApp) —
                  under agreements that limit their use of your data;
                </>,
                <>
                  where required by <Strong>law</Strong>, or to protect the rights, safety, and
                  security of users and the public.
                </>,
              ]}
            />
          </Section>

          <Section title="Data retention">
            <Paragraph>
              We keep your personal information for as long as your account is active and as needed
              to provide the service. If you delete your account, we remove your login and profile,
              but appointment and payment records that a salon must keep for legal and accounting
              reasons are retained and unlinked from your account.
            </Paragraph>
          </Section>

          <Section title="Your rights">
            <Paragraph>
              Depending on where you live, you may have the right to access, correct, or delete your
              personal information, and to object to or restrict certain processing. You can delete
              your account at any time from the qlooqo app or on our{' '}
              <Link
                to="/delete-account"
                className="font-medium text-primary-deep hover:underline"
              >
                account deletion page
              </Link>
              . To exercise any other right, contact us using the details below.
            </Paragraph>
          </Section>

          <Section title="Security">
            <Paragraph>
              We use technical and organisational measures to protect your information, including
              encryption in transit and access controls. No method of transmission or storage is
              completely secure, so we cannot guarantee absolute security.
            </Paragraph>
          </Section>

          <Section title="Children">
            <Paragraph>
              qlooqo is not directed to children, and we do not knowingly collect personal
              information from anyone under the age required to consent in their country without a
              parent or guardian.
            </Paragraph>
          </Section>

          <Section title="Changes to this policy">
            <Paragraph>
              We may update this policy from time to time. When we do, we will revise the &ldquo;Last
              updated&rdquo; date above, and significant changes will be communicated through the
              app where appropriate.
            </Paragraph>
          </Section>

          <Section title="Contact us">
            <Paragraph>
              If you have questions about this policy or your personal information, contact us at{' '}
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="font-medium text-primary-deep hover:underline"
              >
                {CONTACT_EMAIL}
              </a>
              .
            </Paragraph>
          </Section>
        </div>

        <div className="mt-10 border-t border-border pt-5 text-center">
          <Link to="/" className="text-[13px] font-medium text-primary-deep hover:underline">
            Back to home
          </Link>
        </div>
      </AppCard>
    </main>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      {title ? (
        <AppText as="h2" variant="subtitle" weight="medium">
          {title}
        </AppText>
      ) : null}
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

function Strong({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-text-primary">{children}</strong>;
}
