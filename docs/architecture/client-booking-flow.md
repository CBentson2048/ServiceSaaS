# Client Booking Flow

The public booking flow now supports a browser-based reservation journey:

1. Location selection
2. Service and stylist / next-available selection
3. Date and time selection
4. Account, contact details, and communication preference
5. Review and Stripe deposit payment
6. Confirmed success summary

The account step is mandatory for this stage. Clients can either create a
new client account or sign in to an existing one in the same browser flow;
installing the app is not required.

Rota is the source of truth for availability. Public availability is
calculated from published `rota.shifts`, with `rota.shift_breaks`,
approved `rota.leave_requests`, `rota.absence_events`, and active
`booking.appointments` removed from the bookable windows.

Service `estimated_duration_minutes` controls the appointment length.
Location `appointment_slot_minutes` controls only the start-time
increments, so 15-minute increments do not imply 15-minute services.

Step 4 ensures the auth user has a `client` membership and a linked
`core.client_profiles` row for the booking location. Phone is stored on
`core.user_profiles` and is also stored or refreshed on
`core.client_profiles` for CRM use. The selected communication preference
is saved to `core.client_profiles.communication_preference` and later copied
onto the appointment when the booking is finalized.

Step 5 calls `POST /api/public/booking/start-checkout`. The API revalidates
the selected rota-backed slot, creates a `booking.booking_attempts` row with
status `pending_payment`, creates a Stripe PaymentIntent, and writes a
pending `booking.deposits` row linked to the booking attempt. Pending,
non-expired booking attempts block overlapping public availability while
the client is checking out.

No confirmed appointment is created before payment succeeds. Stripe webhooks
are verified with `STRIPE_WEBHOOK_SECRET`; `payment_intent.succeeded`
idempotently creates `booking.appointments` and
`booking.appointment_services`, updates the deposit to `paid`, and marks the
attempt `confirmed`. `payment_intent.payment_failed` marks the attempt and
deposit failed and does not create an appointment.

The success screen assumes the client already created or signed into an
account and only shows a confirmation once the backend returns a confirmed
booking attempt with a real appointment. It may recommend app installation
as a post-booking convenience, but it does not offer contradictory
"create account later" actions.

Deferred items: confirmation messaging hooks are intentionally left ready
for the future comms pipeline, and Stripe Connect / tenant payout routing is
not yet modeled in schema or code.
