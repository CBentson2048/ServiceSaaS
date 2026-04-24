# Row Level Security Policies

RLS is implemented in `database/migrations/0014_rls_helpers_and_policies.sql`.

## Security model

- All sensitive tenant-owned tables have RLS enabled.
- Access is anchored on `business_id`, `location_id`, authenticated membership, and relationship helpers.
- Owners/admins are business-wide.
- Managers are location-scoped.
- Front desk users operate booking/CRM/comms within their location.
- Stylists/assistants are constrained to their own rota, appointments, and legitimate client/formula context.
- Clients are constrained to their own appointment history, payment history, communication history, and client-safe visit summaries.

## Conservative financial visibility

The database stores financial truth, but default visibility stays tight:

- `lab.formula_costs` and `inventory.product_costs` separate owner/manager financial data from operational detail.
- Stylists do not get cost, margin, billing-rule, or tax-setting access by default.
- Clients never get raw formula ingredient-cost detail.
- Managers do not inherit business-wide visibility from location membership.

## Helper functions

The policy layer uses reusable `security definer` helpers to avoid recursive RLS traps:

- `public.is_business_owner_or_admin(...)`
- `public.has_location_membership(...)`
- `public.has_location_management_scope(...)`
- `public.has_location_desk_access(...)`
- `public.has_location_operational_access(...)`
- `public.can_view_financials(...)`
- `public.is_staff_profile_owner(...)`
- `public.is_client_profile_owner(...)`
- `public.can_access_client_profile(...)`
- `public.can_access_appointment(...)`
- `public.can_access_visit(...)`
- `public.can_access_formula(...)`

## Expected role outcomes

- `owner` / `admin` — business-wide access across operational, financial, analytics, and audit domains
- `manager` — location-scoped operational and local financial access only
- `front_desk` — booking, CRM, and communication access for their location
- `stylist` / `assistant` — own rota and appointment context, plus client/formula records tied to their work
- `client` — own appointments, deposits/payments, comms history, and client-safe visit summaries

## Review rule

Every future tenant-owned table should ship with:

1. `business_id` and/or `location_id` where appropriate
2. RLS enabled
3. explicit policies, or a short documented reason why policy work is deferred
