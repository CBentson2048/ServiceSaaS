# Database

Source of truth for the Sheer Platform data layer. We target **PostgreSQL** via **Supabase**.

## Layout

- `schema/` — raw SQL schema files (one file per domain, e.g. `auth.sql`, `booking.sql`).
- `migrations/` — ordered, timestamped migration files (applied by Supabase CLI or a migrator of choice).
- `policies/` — Row Level Security policies. Kept separate from schema for easy review.
- `seeds/` — seed data for development and staging environments.

## Tooling (planned)

- Supabase CLI for local dev DB + migrations (`supabase start`, `supabase db push`).
- `drizzle-kit` or `prisma` in the API layer once we commit to an ORM.

## Conventions

- Snake_case for tables and columns.
- `id uuid primary key default gen_random_uuid()` on all mutable entities.
- `created_at`, `updated_at` timestamps everywhere.
- Every tenant-scoped table has a `location_id` (or `tenant_id`) column and a matching RLS policy.

## Environments

- **Local** — Supabase running in Docker via `supabase start`.
- **Staging** — dedicated Supabase project.
- **Production** — dedicated Supabase project with backups + point-in-time recovery.
