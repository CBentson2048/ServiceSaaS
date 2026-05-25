# Release Readiness RC

## Audit Scope

This hardening pass reviewed the current release-candidate surface across auth and role boundaries, public booking, Stripe deposit finalization, CRM/client history, communications logs, rota-backed availability, Sheer Lab BLE/formula capture, formula billing/inventory/waste reconciliation, owner/manager analytics, Supabase migrations, environment validation, and monorepo build/test scripts.

## Fixes Applied

- Stripe deposit PaymentIntents now leave payment method selection to Stripe dynamic payment methods instead of hardcoding card-only methods.
- Public booking webhook handling now logs PaymentIntent correlation, failed-payment reasons, deposit paid transitions, and booking-attempt finalization.
- Payment success finalization now re-reads the booking attempt, guards the pending-to-confirmed transition with `appointment_id is null`, cleans up orphan appointments if the transition loses a race, and adds a database uniqueness guard so a booking attempt cannot produce duplicate appointments.
- Owner Sheer Lab analytics can request a specific location without being incorrectly constrained by `allowedLocationIds`; manager/stylist scopes remain enforced.
- Formula start/save/duplicate now validates appointment, visit, business, location, stylist, and client scope before accepting lab formula context.
- BLE disconnect and notification-error paths now clear stale live weight readings so manual fallback is not contaminated by a previous scale reading.

## Critical Environment Requirements

- API: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.
- Stripe deposits: `STRIPE_SECRET_KEY` or preferably a least-privilege restricted key, plus `STRIPE_WEBHOOK_SECRET`.
- Web: `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY`.
- Sheer Lab: `SHEER_LAB_API_URL` (host URL is accepted; the app appends `/api` when omitted) and platform bundle/package identifiers for release builds.
- Production secrets must be managed outside source control and rotated per environment.

## Manual QA Matrix

Run these before release sign-off:

- Booking happy path: location, multi-service selection where configured, stylist or next available, date/time, sign in/up, review, deposit, success.
- Booking payment failure and cancel: failed/cancelled payment must leave no confirmed appointment and must mark attempt/deposit state clearly.
- Webhook replay: replay `payment_intent.succeeded` and confirm one appointment, one deposit row, and no duplicate appointment services.
- CRM linkage: confirmed appointment links to the correct client; communication preference and message history appear on the CRM profile.
- Rota availability: shift, break, approved leave, and absence changes affect available slots.
- Role abuse checks: stylist cannot access owner analytics or other stylists' bookings/formulas; manager cannot access other locations; client sees only own history.
- Sheer Lab BLE success: permission grant, scan, connect, live packet capture, save formula, billing/inventory/waste reconciliation.
- Sheer Lab BLE fallback: permission denial, malformed/missing packets, disconnect mid-mix, reconnect, manual weight save.
- Formula edit: edit a saved formula and verify billing line item, inventory reversal/re-deduction, waste events, and low-stock alerts remain reconciled.
- Owner/manager analytics: totals reconcile to underlying formulas, billing line items, inventory movements, and low-stock rows.

## Deferred Items

- Automated E2E coverage is still mostly TODO scaffolding for public booking/payment and needs a real data harness before release automation can prove the full flow. Blocker for unattended release, non-blocker for a manually verified pilot.
- Messaging delivery callback endpoints and reminder scheduling were not fully implemented in this pass. Blocker only if SMS/WhatsApp reminders are in the release contract; otherwise document as deferred.
- Sheer Lab mobile BLE behavior still needs physical device testing on iOS and Android. Blocker for production BLE claims.
- Migration rollback/backfill scripts are not yet present for every recent schema addition. Non-blocker for empty/staging databases, blocker for production data migration.

## Release / Rollback Notes

- Apply migrations in order in a staging database first, then run booking/payment replay QA against Stripe test mode.
- Verify the `0022_release_candidate_hardening.sql` unique index succeeds before production deploy; if duplicate appointment metadata already exists, resolve those rows before applying.
- Rollback of the API release should be paired with disabling the Stripe webhook endpoint or routing it back to the previous deployment to avoid mixed finalization behavior.
