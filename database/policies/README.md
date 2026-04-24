# Row Level Security Policies

RLS is implemented in `supabase/migrations/0007_rls_helpers_and_policies.sql`.

## Week 1 posture

- All Week 1 tenant-owned operational tables have RLS enabled.
- Policies are membership-driven using `business_id`, `location_id`, and authenticated user relationships.
- Owners/admins are business-wide.
- Managers are location-scoped.
- Front desk access is limited to location booking/comms operations.
- Stylists only get their own appointment/rota context where explicitly allowed.
- Clients only get their own appointment, deposit, visit, and communication history.

## Helper functions

The initial policy layer uses small `security definer` helpers:

- `public.is_business_owner_or_admin(...)`
- `public.has_location_membership(...)`
- `public.has_location_management_scope(...)`
- `public.has_location_desk_access(...)`
- `public.current_staff_profile_id(...)`
- `public.is_staff_profile_owner(...)`
- `public.is_client_profile_owner(...)`
- `public.can_access_appointment(...)`

## Conservative boundary

Week 1 keeps direct write access tight. The intended pattern is:

- client apps read through RLS-safe tables/views
- privileged writes go through the NestJS API using service-role access
- later domain tables inherit the same membership-first policy structure
