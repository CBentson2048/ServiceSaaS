# Multi-Service Booking And CRM Update

The public booking flow now treats an appointment as a set of selected services. The appointment header remains `booking.appointments`, while each service is persisted through normalized service-line tables: pending checkout lines in `booking.booking_attempt_services` and confirmed appointment lines in `booking.appointment_services`.

Availability and next-available searches use the stacked duration, calculated as the sum of `booking.services.estimated_duration_minutes` for every selected service. The rota engine still uses published shifts as the source of bookable time and excludes breaks, approved leave, absences, active appointments, and pending non-expired booking attempts.

Mandatory finishing services are owner-configurable through `booking.service_requirement_rules` and `booking.service_requirement_options`. A rule belongs to a business and can be scoped to a location; when its trigger service is selected, at least one configured option must also be selected. The public UI prompts clients before stylist selection, and checkout validates the same rules server-side.

Upgrade prompts are configured in `booking.service_upgrade_suggestions`. Each suggestion is linked to a trigger service and a suggested service, with a short title and description. Accepted upgrades are appended to the selected service set; skipped upgrades do not block booking unless a mandatory finishing rule requires them.

Client Q codes live in `core.client_profiles.client_code`. Codes are generated server-side, alphanumeric, at least eight characters, globally unique, and protected by a trigger that prevents mutation after creation. The CRM list and client profile surfaces display the code.

Deposit collection remains Stripe PaymentIntent based. Deposit PaymentIntents now explicitly use `payment_method_types: ['card']`, which allows card, Apple Pay, and Google Pay wallets while excluding Klarna and Revolut Pay from the deposit step. Future full-balance payments can use a different PaymentIntent configuration.
