# Schema

This folder documents the intended shape of the Sheer Platform data model. The executable SQL lives in `database/migrations/`.

## Domain split

- `core` — businesses, locations, users, memberships, staff, clients, settings
- `booking` — services, appointments, deposits, waitlist, visits
- `crm` — notes, patch tests, allergies, summaries, photo metadata
- `rota` — shifts, breaks, leave, absences, availability overrides
- `lab` — device pairings, formulas, versions, events, ingredient lines, cost records
- `inventory` — products, stock, movements, waste, alerts, cost records
- `billing` — tax settings, billing rules, visit charges, totals, payments, refunds
- `analytics` — targets, KPI snapshots, commission plans/runs, daily metrics
- `comms` — templates, notification events, logs, preference history
- `audit` — audit events, webhooks, login events, export events

## Modeling posture

- Model for 4 current locations without baking in a single-business ceiling.
- Prefer normalized operational tables first; add snapshots where business calculations need historical stability.
- Keep formula and product cost data in owner-safe tables so stylists can access operational detail without seeing margin configuration by default.
- Store file metadata only. Assets belong in Supabase Storage, not Postgres blobs.
- Keep visit summaries client-safe and separate from raw formula/billing detail.

## Migration set

The current ordered migration chain is:

- `0001_extensions_and_helpers.sql`
- `0002_create_app_schemas.sql`
- `0003_core_businesses_locations_users.sql`
- `0004_core_settings_roles_clients.sql`
- `0005_booking_services_appointments_visits.sql`
- `0006_crm_notes_patchtests_photos.sql`
- `0007_rota_shifts_breaks_leave_absence.sql`
- `0008_lab_formulas_formula_items.sql`
- `0009_inventory_products_stock_movements.sql`
- `0010_billing_tax_rules_charges_payments.sql`
- `0011_comms_notifications_message_logs.sql`
- `0012_analytics_targets_commissions.sql`
- `0013_audit_events_webhooks.sql`
- `0014_rls_helpers_and_policies.sql`
- `0015_indexes_constraints_views.sql`
