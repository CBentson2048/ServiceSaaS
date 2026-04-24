# Database

Schema assets for the Sheer Platform data layer.

## Source of truth

- `supabase/migrations/` — ordered, runnable SQL migrations used by Supabase CLI
- `database/schema/` — reference/design notes
- `database/policies/` — RLS rationale and policy notes
- `database/seeds/` — seed strategy notes

## Week 1 scope

The current migration set establishes only the database foundation:

- application schemas: `core`, `booking`, `crm`, `rota`, `lab`, `inventory`, `billing`, `analytics`, `comms`, `audit`
- tenant and identity foundation in `core`
- booking foundation in `booking`
- rota foundation in `rota`
- billing/tax and communications foundation in `billing` and `comms`
- initial helper functions, foreign keys, indexes, triggers, and conservative RLS structure

Later CRM, lab, inventory, analytics, and audit domain tables should land as additive migrations rather than being guessed upfront.

## Design notes

- Multi-business tenancy is anchored at `core.businesses`.
- `core.locations` provides current location isolation while preserving future white-label readiness.
- UUID primary keys, `timestamptz`, `snake_case`, and `created_at` / `updated_at` are the defaults.
- Rota is the source of truth for staff availability.
- Tax configuration is location-aware and jurisdiction-neutral.
- Default RLS exposure is conservative: owners/admins are business-wide, managers are location-scoped, and staff/client visibility is narrowly bounded.

## Migration order

1. `0001_extensions_and_helpers.sql`
2. `0002_create_app_schemas.sql`
3. `0003_core_foundation.sql`
4. `0004_booking_foundation.sql`
5. `0005_rota_foundation.sql`
6. `0006_billing_and_comms_foundation.sql`
7. `0007_rls_helpers_and_policies.sql`
8. `0008_indexes_and_triggers.sql`
