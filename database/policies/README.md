# Row Level Security policies

Every tenant-scoped table **must** have RLS enabled and at least one policy per role that should access it.

## Guiding rules

- `owner` / `manager` — full access within their tenant/location(s).
- `stylist` / `assistant` / `front_desk` — read their location's operational data, write only to their own records (e.g. their own bookings, notes).
- `client` — read/write only their own profile, bookings, and messages.
- Service role key (backend only) — bypasses RLS for system jobs.

## Structure

One file per table or domain (e.g. `bookings.sql`, `clients.sql`). Each file:

1. Enables RLS on the target table.
2. Defines policies, grouped by role.
3. Ends with a comment block listing expected queries and whether they pass/fail.

Keep policies narrow. Prefer many small policies over one that tries to cover every case.
