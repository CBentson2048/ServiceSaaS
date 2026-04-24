# Seeds

Seed data should support local workflow testing without turning production migrations into demo-data dumps.

## Seed strategy

- Keep schema creation in `database/migrations/`.
- Keep environment-specific sample data out of the migration chain.
- Seed deterministic businesses, locations, staff, clients, services, rota rows, and appointments that exercise RLS and booking flows.
- Prefer idempotent inserts keyed by stable slugs or fixed UUIDs for local/staging fixtures.

## Current workflow

- Supabase Auth fixture users can be created from `apps/api/scripts/create-test-users.ts`.
- Relational seed data should mirror those auth users by creating:
  - one business
  - four locations
  - owner, managers, stylists, and client memberships/profiles
  - representative services, rota rows, appointments, visits, formulas, and stock records

## Recommended split

- `local` seeds: realistic but lightweight data for developer workflows
- `staging` seeds: richer scenario coverage for QA and RLS verification
- `production`: no general-purpose seed data, only controlled bootstrap/admin scripts

## Rule

If a seed depends on auth user IDs, document the dependency clearly and keep the seed idempotent.
