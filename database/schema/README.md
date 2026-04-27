# Schema

This folder documents schema intent. Executable SQL lives in `supabase/migrations/`.

## Week 1 foundation domains

- `core` — businesses, locations, user profiles, memberships, staff, clients, location settings
- `booking` — services, appointments, appointment services, deposits, visits
- `rota` — shifts, breaks, leave requests, absence events
- `billing` — tax settings and location billing rules
- `comms` — notification events and message logs

## Reserved schemas

These schemas are created in Week 1 so the platform layout is stable, but their deeper table sets are intentionally deferred:

- `crm`
- `lab`
- `inventory`
- `analytics`
- `audit`

## Modeling posture

- Model for multiple businesses and multiple locations from day one.
- Keep the operational source of truth normalized.
- Carry `business_id` and `location_id` through tenant-owned operational tables where it matters for joins and RLS.
- Use conservative separation between operational access and finance/config access.
