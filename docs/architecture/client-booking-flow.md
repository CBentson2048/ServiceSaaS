# Client Booking Flow

The public booking flow now supports a browser-based reservation journey:

1. Location selection
2. Service and stylist / next-available selection
3. Date and time selection
4. Account, contact details, and communication preference
5. Review and booking creation, followed by a success summary

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
`core.client_profiles` row for the booking location. The selected
communication preference is saved to the client CRM record and also copied
onto the appointment. Appointment creation requires that client
profile/user context, revalidates the selected slot, then creates
`booking.appointments` and `booking.appointment_services`.

The success screen assumes the client already created or signed into an
account. It summarizes the created reservation and may recommend app
installation as a post-booking convenience, but it does not offer
contradictory "create account later" actions.

Deposit handling is deposit-ready but payment collection is deferred.
The appointment service row stores `deposit_required_amount`; the UI
shows an honest placeholder until Stripe checkout is implemented. No
Stripe success is simulated in this stage.
