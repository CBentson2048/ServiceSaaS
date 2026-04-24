# Database

Production-minded PostgreSQL/Supabase schema assets for the Sheer Platform.

## Source of truth

- `database/migrations/` — ordered, runnable SQL migrations
- `database/schema/` — schema intent and modeling notes
- `database/policies/` — RLS rationale and access model notes
- `database/seeds/` — seed strategy and environment guidance

## Runtime schemas

- `core`
- `booking`
- `crm`
- `rota`
- `lab`
- `inventory`
- `billing`
- `analytics`
- `comms`
- `audit`

## Design rules

- Multi-business tenancy is anchored at `core.businesses`.
- `core.locations` provides current location isolation and future white-label readiness.
- Operational tables keep raw source-of-truth data; analytics tables are snapshots, not replacements.
- UUID primary keys, `timestamptz`, `snake_case`, and `created_at` / `updated_at` are the default.
- Financial data is stored in the database, but default RLS remains conservative for stylist-facing access.
- Rota is the source of truth for availability and target calculations.

## Migration sequence

1. `0001_extensions_and_helpers.sql`
2. `0002_create_app_schemas.sql`
3. `0003_core_businesses_locations_users.sql`
4. `0004_core_settings_roles_clients.sql`
5. `0005_booking_services_appointments_visits.sql`
6. `0006_crm_notes_patchtests_photos.sql`
7. `0007_rota_shifts_breaks_leave_absence.sql`
8. `0008_lab_formulas_formula_items.sql`
9. `0009_inventory_products_stock_movements.sql`
10. `0010_billing_tax_rules_charges_payments.sql`
11. `0011_comms_notifications_message_logs.sql`
12. `0012_analytics_targets_commissions.sql`
13. `0013_audit_events_webhooks.sql`
14. `0014_rls_helpers_and_policies.sql`
15. `0015_indexes_constraints_views.sql`

## Operational note

This repo keeps migration authoring under `database/migrations/`. If your deployment workflow still expects a different execution path, wire that runner explicitly rather than splitting schema intent across duplicate SQL sources.
