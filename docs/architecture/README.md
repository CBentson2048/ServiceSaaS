# Architecture

High-level view of how Sheer Platform's apps and services fit together.

## Topology

```
apps/sheer-app       apps/sheer-lab       apps/web
Expo RN phone        Expo RN iPad         Vite React
     | HTTPS              | HTTPS             | HTTPS
     v                    v                   v
                    +-----------------------+
                    |      apps/api         |
                    |       NestJS          |
                    +-----------+-----------+
                                |
                                v
                    +-----------------------+
                    |      Supabase         |
                    | Postgres + Auth + RLS |
                    +-----------------------+
```

## App responsibilities

- **apps/sheer-app** - Personal stylist phone app for dashboard, bookings, rota, performance, and commissions. No BLE.
- **apps/sheer-lab** - Shared salon iPad app for formula workflow, product usage, PIN unlock, and BLE scale integration.
- **apps/web** - Owner/manager dashboard: bookings, CRM, rota, commission, reporting, admin.
- **apps/api** - NestJS HTTP API. Owns business logic, integrates with Supabase (service role), Stripe, Twilio, and BLE backend services.

## Shared

- `packages/types` - domain DTOs shared by every app.
- `packages/utils` - formatting and small helpers.
- `packages/config` - ESLint and tsconfig presets.

## Data

- Single Postgres (Supabase) per environment (dev, staging, prod).
- Multi-tenant via `location_id` columns + RLS policies.
- Auth via Supabase Auth; JWT verified by NestJS guards.

## Sessions

No client uses `supabase-js`: every surface signs in through the API, stores the
returned `AuthSession`, and rotates it before the one-hour access token expires.
See **[session-management.md](session-management.md)** for the state machine,
the "an outage is not an expired session" rule, sign-out scope, and the known
gaps (including the Lab's separate device/PIN sessions, described in
[sheer-lab-session-flow.md](sheer-lab-session-flow.md)).

## Planned ADRs

- 0001 - Supabase vs self-hosted Postgres
- 0002 - Monorepo layout (this repo)
- 0003 - Mobile framework choice (Expo)
- 0004 - API framework choice (NestJS)
