-- 0070_salon_payments_split_tender.sql
-- Split-tender checkout: a visit can now settle across multiple payment methods
-- (e.g. £30 cash + £42 card). One row per tender replaces one row per visit.
--
-- The old unique (visit_id) doubled as the double-submit guard: a concurrent
-- retry hit the constraint and the service replayed the existing row. Keep that
-- property per method with unique (visit_id, payment_method) — a confirmation
-- writes at most one cash row and one card row, so an identical retry still
-- collides and replays instead of double-charging. Existing data (one row per
-- visit) trivially satisfies the new constraint.

alter table billing.salon_payments
  drop constraint if exists salon_payments_visit_id_key;

alter table billing.salon_payments
  drop constraint if exists salon_payments_visit_method_key;

alter table billing.salon_payments
  add constraint salon_payments_visit_method_key unique (visit_id, payment_method);
