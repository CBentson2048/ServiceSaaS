-- 0002_create_app_schemas.sql
-- Creates the application schemas and grants schema usage to runtime roles.

create schema core;
create schema booking;
create schema crm;
create schema rota;
create schema lab;
create schema inventory;
create schema billing;
create schema analytics;
create schema comms;
create schema audit;

comment on schema core is 'Tenant roots, users, memberships, clients, settings.';
comment on schema booking is 'Booking catalog, appointments, deposits, visits, waitlist.';
comment on schema crm is 'Client notes, allergy records, summaries, photo metadata.';
comment on schema rota is 'Shifts, breaks, leave, absences, availability overrides.';
comment on schema lab is 'Sheer Lab formulas, versions, events, and device pairings.';
comment on schema inventory is 'Product catalog, stock, stock movements, and alerts.';
comment on schema billing is 'Tax configuration, visit charges, totals, payments, refunds.';
comment on schema analytics is 'Targets, KPI snapshots, commission runs, and derived metrics.';
comment on schema comms is 'Templates, notification events, logs, and preference history.';
comment on schema audit is 'Audit trail, webhooks, login events, and exports.';

grant usage on schema core, booking, crm, rota, lab, inventory, billing, analytics, comms, audit
to authenticated, service_role;

alter default privileges in schema core, booking, crm, rota, lab, inventory, billing, analytics, comms, audit
grant select, insert, update, delete on tables to authenticated, service_role;

alter default privileges in schema core, booking, crm, rota, lab, inventory, billing, analytics, comms, audit
grant usage on sequences to authenticated, service_role;
