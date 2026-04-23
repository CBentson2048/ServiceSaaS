# Schema

Declarative SQL schema per domain. Migrations in `../migrations` are derived from changes here.

## Planned files

- `auth.sql` — users, roles, tenants, invites.
- `locations.sql` — salon locations, opening hours.
- `staff.sql` — stylists, assistants, front-desk; links to auth users.
- `clients.sql` — client profiles, contact info, consent flags.
- `services.sql` — service catalogue, durations, pricing.
- `bookings.sql` — appointments, statuses, deposits.
- `rota.sql` — shifts, availability, time off.
- `sheer_lab.sql` — BLE formula sessions, saved recipes.
- `billing.sql` — Stripe customer/subscription links, invoices.
- `commission.sql` — commission rules, payroll runs.

Keep each file idempotent where possible (`create table if not exists ...`) for easy re-runs in dev.
