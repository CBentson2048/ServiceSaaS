-- 0108_message_usage_hardening.sql
-- Targeted hardening of the message usage accounting layer (QLOOQO V1.1,
-- Wrike 4507284256), after the billing-integrity audit of 0107.
--
-- 0107 built a correct exactly-once ledger. The audit found that the ledger is
-- sound and that everything around its edges is not: a sent message whose
-- accounting write failed had no automatic way back, the only recovery routine
-- could not actually FIND an old gap, and a message with no shared identity
-- would have split into two units the moment it fell back a channel.
--
-- WHAT THIS ADDS
--   1. comms.logical_message_key(...)     — the SQL mirror of logicalMessageKey().
--   2. comms.notification_events.root_event_id
--                                         — the stable identity a fallback chain
--                                           inherits when it has nothing else.
--   3. comms.find_unaccounted_sends(...)  — the anti-join that bounds its LIMIT by
--                                           MISSING ledger entries, not by traffic.
--   4. A partial index supporting that scan.
--   5. The reminder OCCURRENCE discriminator, so a reminder legitimately re-sent
--      after a reschedule is a second logical message rather than a free one.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   NO change to comms.record_message_usage. It was already correct: it takes the
--   period dates as PARAMETERS and reads no clock, so posting a recovered
--   September send into September is purely an API-side decision. It already
--   writes the period snapshot once and derives overage from the stored
--   allowance, which is exactly the semantics section 6 of the ticket asks the
--   API to start honouring everywhere else.
--
--   NO new usage table, NO second counter, NO change to the allowance numbers,
--   and NO change to the principle that one logical outbound communication is
--   one unit. This migration only makes the identity harder to lose.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. The stable root identity for a fallback chain
-- =============================================================================
--
-- THE GAP THIS CLOSES. logicalMessageKey() resolves, in order:
--     dedupe_key present   -> dk:<business>:<dedupe_key>
--     appointment-anchored -> ap:<appointment>:<event_key>
--     neither              -> ev:<event_id>
--
-- The first two survive a fallback because NotificationEscalationService copies
-- those columns onto the new row verbatim. The third does not: a fallback is a
-- NEW row with a NEW id, so one logical message would acquire two keys and cost
-- two units. No shipped caller reaches that branch today — campaigns supply a
-- dedupe_key and every appointment message supplies an appointment_id — but the
-- invariant was a convention, not a guarantee, and the first caller to omit both
-- would have been billed twice with nothing to catch it.
--
-- WHY A ROOT POINTER RATHER THAN A SYNTHESISED dedupe_key. Synthesising an
-- idempotency key from (business, client, event_key, scheduled_for) would make
-- two genuinely distinct messages collide — and because dedupe_key is backed by
-- notification_events_dedupe_unique_idx, that collision does not merely
-- undercount, it makes the second message NEVER SEND. Trading a double count for
-- a silently dropped client message is not a trade worth making. A root pointer
-- adds identity without ever merging two messages that were not already one.
--
-- NULL means "I am my own root", so every existing row is already correct and no
-- backfill is required.

alter table comms.notification_events
  add column if not exists root_event_id uuid references comms.notification_events(id) on delete set null;

comment on column comms.notification_events.root_event_id is
  'The FIRST event of this logical message''s fallback chain (0108, Wrike 4507284256). NULL means '
  'this row is itself the root. NotificationEscalationService copies the original''s root onto every '
  'fallback it queues, so a WhatsApp -> SMS -> Email chain shares one identity even when the message '
  'carries neither a dedupe_key nor an appointment_id — the case that would otherwise be billed once '
  'per hop. ON DELETE SET NULL because pruning an old queue row must never break accounting: the '
  'ledger entry has already been written by then, and the surviving row simply becomes its own root.';

create index if not exists idx_notification_events_root
  on comms.notification_events (root_event_id)
  where root_event_id is not null;

-- =============================================================================
-- 2. The SQL mirror of logicalMessageKey()
-- =============================================================================
--
-- THIS IS A FILTER, NEVER A WRITE KEY. The key actually written to the ledger is
-- always the one the API computes in TypeScript. This function exists solely so
-- the anti-join below can ask "does a ledger row already exist for this event's
-- logical message?" without shipping every sent event to the API to find out.
--
-- WHAT A DIVERGENCE WOULD COST. If this function and logicalMessageKey() ever
-- disagree, the worst outcome is a wasted idempotent RPC — the recorder receives
-- the API's key, and the ledger's UNIQUE absorbs a repeat. It cannot double
-- count, and it cannot invent usage. The recovery service additionally compares
-- the two keys per row and logs a warning on any mismatch, so drift becomes an
-- observable event rather than a silent one.
--
-- ON btrim VS JavaScript trim(). JS trim() strips a wider set (all Unicode
-- whitespace) than the ASCII set named here. That asymmetry is deliberately in
-- the SAFE direction: this function trims a SUBSET, so its key can only ever
-- retain whitespace the API would have stripped — and no API-written ledger key
-- can contain that whitespace, so a row is at worst OFFERED for recovery and
-- then found to be already counted. Widening this set toward JS's is safe;
-- trimming more than JS does is not.

-- Dropped first because the signature gains a parameter: `create or replace`
-- would leave the previous arity behind as a second overload, and a call with
-- the defaulted arguments would then be ambiguous.
drop function if exists comms.logical_message_key(uuid, text, uuid, text, uuid, uuid);

create or replace function comms.logical_message_key(
  p_business_id uuid,
  p_dedupe_key text,
  p_appointment_id uuid,
  p_event_key text,
  p_event_id uuid,
  p_root_event_id uuid default null,
  p_occurrence_key text default null
)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when nullif(btrim(coalesce(p_dedupe_key, ''), E' \t\n\r\f\x0B'), '') is not null
      then 'dk:' || p_business_id::text || ':' || btrim(p_dedupe_key, E' \t\n\r\f\x0B')
    when p_appointment_id is not null
      then 'ap:' || p_appointment_id::text || ':' || coalesce(p_event_key, '')
           || coalesce('@' || nullif(btrim(coalesce(p_occurrence_key, ''), E' \t\n\r\f\x0B'), ''), '')
    else 'ev:' || coalesce(p_root_event_id, p_event_id)::text
  end
$$;

comment on function comms.logical_message_key(uuid, text, uuid, text, uuid, uuid, text) is
  'SQL mirror of logicalMessageKey() in @sheer/domain (packages/domain/src/message-usage.ts), used '
  'ONLY to filter comms.find_unaccounted_sends. The key written to the ledger is always the one the '
  'API computes, so a divergence between the two costs a wasted idempotent RPC and can never '
  'miscount. Golden vectors are pinned in BOTH message-usage-rules.spec.ts and '
  'supabase/tests/message_usage_accounting.sql, so changing one without the other goes red.';

revoke all on function comms.logical_message_key(uuid, text, uuid, text, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function comms.logical_message_key(uuid, text, uuid, text, uuid, uuid, text)
  to service_role;

-- =============================================================================
-- 2b. The reminder occurrence discriminator
-- =============================================================================
--
-- SQL mirror of reminderOccurrenceKey() in apps/api/src/communications/
-- notification.types.ts. Same contract as the key function above: it only ever
-- FILTERS, so a divergence costs a wasted idempotent call, never a miscount.
--
-- WHY REMINDERS ONLY. An appointment emits its confirmation once, but it can
-- legitimately emit the same reminder event_key twice: send the 24h reminder,
-- reschedule the appointment, and the client must be reminded again at the new
-- time. That is a second real message, and without this it reuses the first
-- one's key and is billed as zero.
--
-- Confirmations and rebooking nudges are excluded deliberately. Their prechecks
-- do NOT compare the payload snapshot against the live appointment, so their
-- snapshot can legitimately be refreshed part-way through a fallback chain —
-- including them here would split one chain into two units. A reminder cannot
-- suffer that, because a reminder whose snapshot has drifted is cancelled by the
-- precheck before any fallback can be queued.

create or replace function comms.reminder_occurrence_key(
  p_event_key text,
  p_payload jsonb
)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when p_event_key in ('appointment_reminder_2h', 'appointment_reminder_24h',
                         'appointment_reminder_48h', 'appointment_reminder_1w')
      then nullif(btrim(coalesce(p_payload->>'appointment_start', ''), E' \t\n\r\f\x0B'), '')
    else null
  end
$$;

comment on function comms.reminder_occurrence_key(text, jsonb) is
  'The occurrence discriminator for a reminder: the appointment start it was scheduled against '
  '(payload_json.appointment_start), which is already what isReminderStale() compares. SQL mirror of '
  'reminderOccurrenceKey() in notification.types.ts, pinned by golden vectors in both '
  'message-usage-rules.spec.ts and supabase/tests/message_usage_accounting.sql. NULL for '
  'confirmations and nudges, whose snapshot may legitimately be refreshed mid-chain.';

revoke all on function comms.reminder_occurrence_key(text, jsonb) from public, anon, authenticated;
grant execute on function comms.reminder_occurrence_key(text, jsonb) to service_role;

-- =============================================================================
-- 3. Scan support
-- =============================================================================
--
-- sent_at is the durable "a provider accepted this" marker and is written exactly
-- once, at accept time, by NotificationDispatchService.markAccepted — the only
-- writer of that column anywhere in the platform. It is therefore monotonic, and
-- ordering the recovery scan by it is stable.

create index if not exists idx_notification_events_sent_countable
  on comms.notification_events (sent_at, id)
  where sent_at is not null and channel in ('whatsapp', 'sms', 'email');

-- =============================================================================
-- 4. The anti-join: sent messages with no ledger entry
-- =============================================================================
--
-- THE LIMIT APPLIES TO MISSING ENTRIES, NOT TO RECENT SENDS. This is the whole
-- point. The previous recovery routine read the newest 500 sent events and
-- re-recorded them all, so a gap sitting behind 500 newer sends was permanently
-- unreachable — the limit was spent on messages that were already accounted for.
-- Here the NOT EXISTS runs before the LIMIT, so the bound is on actual gaps.
--
-- OLDEST FIRST, WITH A KEYSET CURSOR. Newest-first can never drain a backlog: it
-- re-reads the same recent window forever. Oldest-first makes repeated runs
-- monotonic, because an accounted row leaves the candidate set permanently. The
-- (p_after_sent_at, p_after_id) cursor lets one tick step past a row it failed to
-- record instead of re-fetching it for the rest of time — the failed row is
-- simply picked up by a later tick, which is exactly the required retry
-- behaviour.
--
-- FILTERS ON sent_at, NOT ON status. A message that has since advanced to
-- delivered, read or undelivered was still accepted by a provider and still
-- consumed a unit. Filtering on status = 'sent' would silently exclude most of
-- the real history.
--
-- THE ANTI-JOIN IS ON THE LOGICAL KEY, NOT ON notification_event_id. Only ONE
-- event per logical message ever carries a ledger row, so joining on the event id
-- would report a fallback's accounted sibling as unaccounted forever and
-- re-record it on every single run.
--
-- A GRACE WINDOW, so recovery never races the dispatcher's own recordSend for a
-- message accepted moments ago.
--
-- IT WRITES NOTHING. It returns candidates; the caller re-derives the ledger key
-- itself and calls the idempotent recorder. It cannot send a message, because it
-- cannot reach a provider.

-- Dropped first: the RETURNS TABLE gains a column, and `create or replace`
-- cannot change a function's return type.
drop function if exists comms.find_unaccounted_sends(integer, integer, uuid, timestamptz, uuid);

create or replace function comms.find_unaccounted_sends(
  p_limit integer default 200,
  p_grace_seconds integer default 300,
  p_business_id uuid default null,
  p_after_sent_at timestamptz default null,
  p_after_id uuid default null
)
returns table (
  id uuid,
  business_id uuid,
  dedupe_key text,
  appointment_id uuid,
  event_key text,
  channel text,
  message_class text,
  root_event_id uuid,
  occurrence_key text,
  sent_at timestamptz,
  logical_message_key text
)
language sql
stable
as $$
  select e.id,
         e.business_id,
         e.dedupe_key,
         e.appointment_id,
         e.event_key,
         e.channel::text,
         case when e.payload_json->>'message_class' = 'marketing' then 'marketing'
              else 'transactional' end,
         e.root_event_id,
         comms.reminder_occurrence_key(e.event_key, e.payload_json),
         e.sent_at,
         comms.logical_message_key(
           e.business_id, e.dedupe_key, e.appointment_id, e.event_key, e.id, e.root_event_id,
           comms.reminder_occurrence_key(e.event_key, e.payload_json))
    from comms.notification_events e
   where e.sent_at is not null
     and e.channel in ('whatsapp', 'sms', 'email')
     and e.sent_at <= now() - make_interval(secs => greatest(coalesce(p_grace_seconds, 0), 0))
     and (p_business_id is null or e.business_id = p_business_id)
     and (p_after_sent_at is null
          or (e.sent_at, e.id) > (p_after_sent_at,
                                  coalesce(p_after_id, '00000000-0000-0000-0000-000000000000'::uuid)))
     and not exists (
           select 1
             from comms.message_usage_entries u
            where u.business_id = e.business_id
              and u.logical_message_key = comms.logical_message_key(
                    e.business_id, e.dedupe_key, e.appointment_id, e.event_key, e.id, e.root_event_id,
                    comms.reminder_occurrence_key(e.event_key, e.payload_json))
         )
   order by e.sent_at asc, e.id asc
   limit greatest(1, least(coalesce(p_limit, 200), 1000))
$$;

comment on function comms.find_unaccounted_sends(integer, integer, uuid, timestamptz, uuid) is
  'Sent, countable comms.notification_events that have NO comms.message_usage_entries row for their '
  'logical key (0108). The bound applies to MISSING entries, not to recent sends, so a gap cannot be '
  'hidden behind newer traffic. Oldest first with a keyset cursor, so repeated runs make monotonic '
  'progress and a row that fails to record is retried on a later pass rather than blocking the scan. '
  'Returns candidates only: it writes nothing, calls no provider, and the caller re-derives the '
  'ledger key itself before recording.';

revoke all on function comms.find_unaccounted_sends(integer, integer, uuid, timestamptz, uuid)
  from public, anon, authenticated;
grant execute on function comms.find_unaccounted_sends(integer, integer, uuid, timestamptz, uuid)
  to service_role;
