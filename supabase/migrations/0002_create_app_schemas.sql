-- 0002_create_app_schemas.sql
-- Application schema layout for the Week 1 foundation.

create schema if not exists core;
create schema if not exists booking;
create schema if not exists crm;
create schema if not exists rota;
create schema if not exists lab;
create schema if not exists inventory;
create schema if not exists billing;
create schema if not exists analytics;
create schema if not exists comms;
create schema if not exists audit;

comment on schema core is 'Tenant roots, identities, memberships, clients, and settings.';
comment on schema booking is 'Services, appointments, deposits, and visits.';
comment on schema crm is 'Reserved for CRM tables added in later phases.';
comment on schema rota is 'Shifts, breaks, leave, and absences.';
comment on schema lab is 'Reserved for Sheer Lab operational tables added in later phases.';
comment on schema inventory is 'Reserved for inventory tables added in later phases.';
comment on schema billing is 'Tax configuration and billing rules.';
comment on schema analytics is 'Reserved for analytics tables added in later phases.';
comment on schema comms is 'Notification events and communication logs.';
comment on schema audit is 'Reserved for audit tables added in later phases.';

grant usage on schema
  core,
  booking,
  crm,
  rota,
  lab,
  inventory,
  billing,
  analytics,
  comms,
  audit
to authenticated, service_role;

alter default privileges in schema
  core,
  booking,
  crm,
  rota,
  lab,
  inventory,
  billing,
  analytics,
  comms,
  audit
grant select, insert, update, delete on tables to authenticated, service_role;

alter default privileges in schema
  core,
  booking,
  crm,
  rota,
  lab,
  inventory,
  billing,
  analytics,
  comms,
  audit
grant usage on sequences to authenticated, service_role;
