-- 0078_payroll_integrity_fixes.sql
-- V1.1 Week 3.2 — Financial Rules Engine Workflow Completion.
--
-- Additive integrity fixes to the Week 3 payroll foundation (0071-0073). Nothing
-- here rewrites an applied migration, drops data, or renumbers anything. Every
-- change is either a `create or replace function`, a new trigger, a new nullable
-- column, a constraint widened rather than narrowed, or a grant tightened.
--
-- WHY THESE, AND NOT OTHERS: each one blocks or silently weakens a workflow the
-- engine already claims to support. They were found by re-reading 0071-0073
-- against the workflow being built on top of them, and two of them (§1 and §2)
-- make documented behaviour impossible rather than merely awkward.
--
-- ⚠️ NOT APPLIED. This file is authored for review only. It has not been run
-- against any database — local, dev-test, develop, staging or production — and
-- `supabase db push` has not been executed.

-- =============================================================================
-- 1. A used pay-rule version must still be closable
-- =============================================================================
-- BLOCKER. payroll.assert_rule_version_unused() (0073 §6b) fires BEFORE UPDATE on
-- payroll.pay_structure_versions with no column allowlist, so ANY update to a
-- version referenced by a pay summary or line is refused - including setting
-- effective_to. But pay_structure_versions_no_overlap (0071:369-373) means an
-- open-ended version (effective_to null => [from, infinity)) overlaps every
-- possible successor, so a new version cannot be inserted until the old one is
-- closed. The trigger's own message tells you to "Close it with an effective_to
-- date and create a new version instead" - which it then forbids.
--
-- Net effect today: once a structure has priced a single pay run, its rates can
-- never be changed again. That contradicts the central design property in
-- 0071:42-47 ("changing a rate closes the current version and inserts a new one").
--
-- FIX: allow exactly two columns to change on a used version - effective_to and
-- notes - and nothing else. Rates, bases and policy columns stay frozen. Closing
-- is additionally guarded so a version cannot be closed across work it already
-- priced, which would retroactively orphan those lines from their rule.

create or replace function payroll.assert_rule_version_unused()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_version_id uuid;
  v_used boolean;
  v_max_line_date date;
  v_max_period_end date;
begin
  if tg_table_name = 'pay_structure_stages' then
    v_version_id := coalesce(old.version_id, new.version_id);
  elsif tg_table_name in ('accelerators', 'version_hour_rules') then
    v_version_id := coalesce(old.version_id, new.version_id);
  elsif tg_table_name = 'pay_structure_bands' then
    select st.version_id into v_version_id
    from payroll.pay_structure_stages st
    where st.id = coalesce(old.stage_id, new.stage_id);
  elsif tg_table_name = 'accelerator_conditions' then
    select a.version_id into v_version_id
    from payroll.accelerators a
    where a.id = coalesce(old.accelerator_id, new.accelerator_id);
  else
    v_version_id := coalesce(old.id, new.id);
  end if;

  select exists (
    select 1 from payroll.pay_summaries s where s.structure_version_id = v_version_id
    union all
    select 1 from payroll.pay_summary_lines l where l.structure_version_id = v_version_id
  ) into v_used;

  if v_used then
    -- The ONE permitted mutation on a used version: closing its effective window
    -- (and annotating why). Everything else stays frozen, including on the child
    -- rule tables, which have no equivalent allowance.
    if tg_table_name = 'pay_structure_versions' and tg_op = 'UPDATE' then
      if (to_jsonb(new) - 'effective_to' - 'notes')
         is distinct from
         (to_jsonb(old) - 'effective_to' - 'notes')
      then
        raise exception
          'Pay rule version % has already been used to calculate pay. Only effective_to and notes may change - create a new version for any rate change.', v_version_id
          using errcode = 'check_violation';
      end if;

      -- Closing the window must not retroactively exclude work this version has
      -- already priced. effective_to is EXCLUSIVE, so a line dated D stays covered
      -- only while D < effective_to.
      if new.effective_to is not null then
        select max(l.occurred_on) into v_max_line_date
        from payroll.pay_summary_lines l
        where l.structure_version_id = new.id
          and l.occurred_on is not null;

        if v_max_line_date is not null and new.effective_to <= v_max_line_date then
          raise exception
            'Cannot close pay rule version % on % - it has already priced work up to %. Close it after that date.',
            new.id, new.effective_to, v_max_line_date
            using errcode = 'check_violation';
        end if;

        select max(p.period_end) into v_max_period_end
        from payroll.pay_summaries s
        join payroll.pay_periods p on p.id = s.pay_period_id
        where s.structure_version_id = new.id;

        if v_max_period_end is not null and new.effective_to < v_max_period_end then
          raise exception
            'Cannot close pay rule version % on % - it governs a pay period running to %.',
            new.id, new.effective_to, v_max_period_end
            using errcode = 'check_violation';
        end if;
      end if;

      return new;
    end if;

    raise exception
      'Pay rule version % has already been used to calculate pay and cannot be modified. Close it with an effective_to date and create a new version instead.', v_version_id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function payroll.assert_rule_version_unused() is
  'Freezes a pay-structure version and its stages once any pay summary or line has been calculated from it. The version row itself may still be closed (effective_to) or annotated (notes), guarded so a close never orphans work the version already priced.';

-- =============================================================================
-- 2. Supersede must be buildable
-- =============================================================================
-- BLOCKER. 0073:410-411 documents "Corrections append a new statement rather than
-- editing this one", but the mechanism cannot be executed in ANY period status:
--
--   * insert the new summary first  -> violates idx_pay_summaries_live_per_staff,
--     the partial unique index (0073:447-449), because both rows are then live.
--   * update the old row first      -> violates the superseded_by_id self-FK,
--     because the target row does not exist yet.
--   * point the old row at itself   -> blocked by pay_summaries_no_self_supersede.
--
-- The self-FK carries no DEFERRABLE clause, so both checks are immediate and no
-- ordering works. Only delete-then-insert succeeds, which loses generated_at,
-- mints a new summary id, and nulls target_adjustments.summary_id.
--
-- FIX: name the constraint and make it DEFERRABLE INITIALLY IMMEDIATE. Ordinary
-- writes keep immediate checking; the supersede path opts in with
-- `set constraints payroll_pay_summaries_superseded_by_fkey deferred` inside its
-- transaction, then updates the old row and inserts the new one. The partial
-- unique index is satisfied at every statement, because the old row leaves the
-- index the moment superseded_by_id is set.
--
-- NOTE for the service layer: PostgREST runs each request in its own transaction,
-- so the supersede flow must be a single Postgres function (or a single RPC), not
-- two supabase-js calls.
--
-- ⚠️ SET CONSTRAINTS resolves an unqualified constraint name through search_path,
-- which does not include `payroll`. The name MUST be schema-qualified:
--     set constraints payroll.payroll_pay_summaries_superseded_by_fkey deferred;
-- Without the qualifier it fails with "constraint does not exist", which reads
-- like the migration never ran.

do $$
declare
  v_conname text;
  v_deferrable boolean;
begin
  -- Resolve the existing self-FK by SHAPE rather than by assumed name: it was
  -- created inline in 0073 and so carries a system-generated name.
  select con.conname, con.condeferrable
    into v_conname, v_deferrable
  from pg_constraint con
  join pg_class rel on rel.oid = con.conrelid
  join pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'payroll'
    and rel.relname = 'pay_summaries'
    and con.contype = 'f'
    and con.conkey = array[
      (select attnum from pg_attribute
        where attrelid = 'payroll.pay_summaries'::regclass
          and attname = 'superseded_by_id')
    ]::smallint[];

  -- Replace unless it is ALREADY both correctly named and deferrable, so a
  -- re-run after a partial application still converges.
  if v_conname is not null
     and (v_conname <> 'payroll_pay_summaries_superseded_by_fkey'
          or coalesce(v_deferrable, false) = false) then
    execute format('alter table payroll.pay_summaries drop constraint %I', v_conname);
    v_conname := null;
  end if;

  if v_conname is null then
    alter table payroll.pay_summaries
      add constraint payroll_pay_summaries_superseded_by_fkey
      foreign key (superseded_by_id)
      references payroll.pay_summaries(id)
      on delete set null
      deferrable initially immediate;
  end if;
end
$$;

comment on column payroll.pay_summaries.superseded_by_id is
  'The statement that replaces this one. The FK is DEFERRABLE: a supersede must run inside one transaction that defers payroll_pay_summaries_superseded_by_fkey, updates this row, then inserts the replacement.';

-- =============================================================================
-- 3. Locked periods must also protect the hours behind the target
-- =============================================================================
-- payroll.pay_summaries and payroll.pay_summary_lines are guarded by
-- assert_period_not_locked(), but payroll.pay_summary_hours (0073 §4b) has NO
-- trigger at all. That table is the evidence for how the Service Revenue Target
-- was derived - the thing 0073:553-555 exists to make explainable - and it stays
-- freely insertable, editable and deletable after a period is locked or paid.
--
-- FIX: teach the existing guard to resolve a period through summary_id for
-- pay_summary_hours exactly as it already does for pay_summary_lines, then attach
-- it. The guard's own logic is unchanged.

create or replace function payroll.assert_period_not_locked()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_old_status payroll.pay_period_status_enum;
  v_new_status payroll.pay_period_status_enum;
begin
  -- Resolve the owning period for BOTH the old and the new row. Checking only
  -- the new parent would let a single UPDATE re-point a locked statement at an
  -- open period and rewrite its figures in the same statement, escaping the
  -- guard entirely.
  if tg_table_name in ('pay_summary_lines', 'pay_summary_hours') then
    if tg_op <> 'INSERT' then
      select p.status into v_old_status
      from payroll.pay_summaries s
      join payroll.pay_periods p on p.id = s.pay_period_id
      where s.id = old.summary_id;
    end if;
    if tg_op <> 'DELETE' then
      select p.status into v_new_status
      from payroll.pay_summaries s
      join payroll.pay_periods p on p.id = s.pay_period_id
      where s.id = new.summary_id;
    end if;
  else
    if tg_op <> 'INSERT' then
      select p.status into v_old_status
      from payroll.pay_periods p where p.id = old.pay_period_id;
    end if;
    if tg_op <> 'DELETE' then
      select p.status into v_new_status
      from payroll.pay_periods p where p.id = new.pay_period_id;
    end if;
  end if;

  if coalesce(v_old_status, v_new_status) in ('locked', 'paid')
     or coalesce(v_new_status, v_old_status) in ('locked', 'paid') then

    -- Inserting into, or deleting from, a locked period is always wrong.
    if tg_op <> 'UPDATE' then
      raise exception
        'Pay period is % - payroll history cannot be changed. Raise a payroll adjustment instead.',
        coalesce(v_old_status, v_new_status)
        using errcode = 'check_violation';
    end if;

    if tg_table_name = 'pay_summaries' then
      -- Explicit ALLOWLIST of what may still change on a locked statement.
      -- An allowlist rather than a list of protected columns: a denylist
      -- silently fails open every time a column is added to the table, and it
      -- previously left pay_period_id and staff_profile_id writable, so a
      -- locked statement could be reassigned to another stylist or period.
      if (to_jsonb(new) - 'exported_at' - 'emailed_at' - 'superseded_by_id'
                        - 'is_stale' - 'stale_reason' - 'updated_at')
         is distinct from
         (to_jsonb(old) - 'exported_at' - 'emailed_at' - 'superseded_by_id'
                        - 'is_stale' - 'stale_reason' - 'updated_at')
      then
        raise exception
          'Pay summary belongs to a % period - only export/email stamps, stale flags and supersede links may change. Raise a payroll adjustment instead.',
          coalesce(v_old_status, v_new_status)
          using errcode = 'check_violation';
      end if;
    else
      raise exception
        'Pay period is % - payroll lines and hours cannot be changed. Raise a payroll adjustment instead.',
        coalesce(v_old_status, v_new_status)
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function payroll.assert_period_not_locked() is
  'Refuses any change to a pay summary, line or hours row once its period is locked or paid, checking the old and new parent period so a row cannot be moved out of the lock. Only export/email stamps, stale flags and supersede links stay writable.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_summary_hours_locked_guard'
      and tgrelid = 'payroll.pay_summary_hours'::regclass
  ) then
    create trigger payroll_pay_summary_hours_locked_guard
      before insert or update or delete on payroll.pay_summary_hours
      for each row execute function payroll.assert_period_not_locked();
  end if;
end
$$;

-- =============================================================================
-- 4. Per-band explainability on a priced line
-- =============================================================================
-- Principle 2 (explainability) requires each band's slice to be priced and shown
-- separately, and 0071:467-478 stores bands as rows precisely so a reviewer can
-- read them. But payroll.pay_summary_lines records stage_id and rate_percent with
-- no band reference, so a statement cannot say WHICH band priced a slice - only
-- that some rate was applied. With an accelerator substituting a rate on one band
-- only, rate_percent alone is ambiguous.
--
-- Nullable, because not every line comes from a band (base pay, rent, deductions,
-- adjustments and unavailable-source lines have none). RESTRICT matches
-- structure_version_id: a band that has priced money must not vanish.

alter table payroll.pay_summary_lines
  add column if not exists band_id uuid references payroll.pay_structure_bands(id) on delete restrict;

comment on column payroll.pay_summary_lines.band_id is
  'The commission band that priced this slice, when the line came from one. Null for base pay, rent, deductions, adjustments and unavailable-source lines.';

create index if not exists idx_pay_summary_lines_band
  on payroll.pay_summary_lines (band_id)
  where band_id is not null;

-- =============================================================================
-- 5. Target adjustments: close the summary_id escape hatch
-- =============================================================================
-- payroll.assert_target_adjustment_immutable() (0073:624-641) only raises when
-- `new.summary_id is not distinct from old.summary_id`. An UPDATE that ALSO
-- changes summary_id therefore passes the guard while rewriting reason,
-- original_target_cents, adjusted_target_cents and adjusted_by_user_profile_id -
-- i.e. exactly the audit record 0073:580-585 says must never be changeable
-- quietly. Same class of hole that was deliberately closed on pay_summaries with
-- an explicit column allowlist.
--
-- FIX: allowlist. summary_id may be filled in later; nothing else may move.

create or replace function payroll.assert_target_adjustment_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'summary_id') is distinct from (to_jsonb(old) - 'summary_id') then
      raise exception
        'A target adjustment is an audit record and cannot be edited. Raise a further adjustment instead.'
        using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception
      'A target adjustment is an audit record and cannot be deleted.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function payroll.assert_target_adjustment_immutable() is
  'Target adjustments are append-only. Only the link to a later-generated summary (summary_id) may be filled in; every other column is frozen, including in the same statement that sets summary_id.';

-- =============================================================================
-- 6. Lock down the SECURITY DEFINER helpers
-- =============================================================================
-- 0071 defines two non-trigger SECURITY DEFINER functions and never revokes the
-- default PUBLIC execute grant, unlike every other definer function in this repo
-- (0010:180, 0011:215-218, 0012:284-294, 0015:150/276, 0024:237, 0029:269,
-- 0031:147-148 all follow revoke-from-public / grant-to-service_role).
--
-- payroll.missing_data_sources(uuid) is the material one: it is STABLE, takes no
-- caller business, and returns stage labels and data-source names for ANY version
-- id in ANY business - a cross-tenant read for any authenticated user.
-- payroll.seed_business_data_sources(uuid) writes rows for an arbitrary business.
--
-- Both remain reachable where they are actually used: the API calls them with the
-- service role, and the new-business trigger calls seed_business_data_sources from
-- inside payroll.seed_business_payroll_defaults(), itself SECURITY DEFINER.

revoke all on function payroll.missing_data_sources(uuid) from public;
grant execute on function payroll.missing_data_sources(uuid) to service_role;

revoke all on function payroll.seed_business_data_sources(uuid) from public;
grant execute on function payroll.seed_business_data_sources(uuid) to service_role;

-- =============================================================================
-- 7. Business-consistency guards on the output tables
-- =============================================================================
-- 0071 added payroll.assert_payroll_business_consistent() for staff_pay_assignments
-- and pay_structure_versions, with the reasoning that a denormalized business_id
-- which drifts from its parent "would leak one salon's rates into another's
-- payroll". The same denormalization exists on the OUTPUT tables and is unguarded:
-- pay_summaries.business_id is never checked against its period or its staff
-- member, and pay_periods.location_id is never checked against business_id.
--
-- Tenant isolation for payroll is entirely application-level (every API service
-- uses the service-role client, which bypasses RLS), so a defence-in-depth check
-- here is worth its cost on tables holding wage data.

create or replace function payroll.assert_summary_business_consistent()
returns trigger
language plpgsql
security definer
set search_path = payroll, core, public
as $$
declare
  v_period_business uuid;
  v_staff_business uuid;
begin
  select business_id into v_period_business
  from payroll.pay_periods where id = new.pay_period_id;

  if v_period_business is null then
    raise exception 'Pay period % does not exist.', new.pay_period_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_period_business <> new.business_id then
    raise exception 'Pay summary belongs to a different business than its pay period.'
      using errcode = 'check_violation';
  end if;

  select business_id into v_staff_business
  from core.staff_profiles where id = new.staff_profile_id;

  if v_staff_business is distinct from new.business_id then
    raise exception 'Staff member belongs to a different business than this pay summary.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function payroll.assert_summary_business_consistent() is
  'Keeps the denormalized business_id on a pay summary in step with its pay period and its staff member.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_summaries_business_guard'
      and tgrelid = 'payroll.pay_summaries'::regclass
  ) then
    create trigger payroll_pay_summaries_business_guard
      before insert or update on payroll.pay_summaries
      for each row execute function payroll.assert_summary_business_consistent();
  end if;
end
$$;

create or replace function payroll.assert_period_location_consistent()
returns trigger
language plpgsql
security definer
set search_path = payroll, core, public
as $$
declare
  v_location_business uuid;
begin
  if new.location_id is null then
    return new;
  end if;

  select business_id into v_location_business
  from core.locations where id = new.location_id;

  if v_location_business is null then
    raise exception 'Location % does not exist.', new.location_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_location_business <> new.business_id then
    raise exception 'Pay period cannot be scoped to a location in another business.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function payroll.assert_period_location_consistent() is
  'Keeps a location-scoped pay period inside its own business.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_periods_location_guard'
      and tgrelid = 'payroll.pay_periods'::regclass
  ) then
    create trigger payroll_pay_periods_location_guard
      before insert or update on payroll.pay_periods
      for each row execute function payroll.assert_period_location_consistent();
  end if;
end
$$;

-- =============================================================================
-- 8. Status ratchet: cover INSERT, and protect the two money-critical edges
-- =============================================================================
-- payroll.assert_period_status_forward_only() (0073:815-843) is attached BEFORE
-- UPDATE only, so a period can be INSERTED directly at status='paid' - born
-- immutable, with no draft, no review, no approval and no actor stamps. The
-- update path is also permissive: 0073:834 raises only when
-- `v_old >= 4 and v_new < v_old`, so draft -> paid in a single statement is
-- accepted.
--
-- FIX, deliberately narrow: a period may not be created already locked or paid.
-- That is the hole with no legitimate use — it produces a born-immutable period
-- with no draft, no approval and no actor stamps.
--
-- ORDERING IS NOT ENFORCED HERE, on purpose. An earlier draft of this migration
-- also required 'locked' to come from 'approved' and 'paid' from 'locked'. It was
-- removed after verification: supabase/tests/payroll_regression.sql:110 moves a
-- period draft -> locked directly to set up its locking fixtures, so the rule made
-- R09-R15 fail or, worse, pass vacuously against a period that was never locked.
-- Rewriting Week 3 fixtures to accommodate a newly invented constraint would
-- degrade exactly the regression signal those cases exist to give.
--
-- The full Draft -> Ready for Review -> Approved -> Locked -> Paid ladder is
-- therefore enforced in the service layer, where the actor stamps and permission
-- checks for each transition already live. Whether it should ALSO be enforced in
-- the database (which requires updating those Week 3 fixtures) is an open
-- decision for review — see docs/V1.1/3-2 plan.md.

create or replace function payroll.assert_period_status_forward_only()
returns trigger
language plpgsql
as $$
declare
  v_old integer;
  v_new integer;
begin
  if tg_op = 'INSERT' then
    if new.status in ('locked', 'paid') then
      raise exception
        'A pay period cannot be created with status % - it must be generated as a draft and approved first.',
        new.status
        using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.status = old.status then
    return new;
  end if;

  v_old := case old.status
             when 'draft' then 1 when 'ready_for_review' then 2 when 'approved' then 3
             when 'locked' then 4 when 'paid' then 5 end;
  v_new := case new.status
             when 'draft' then 1 when 'ready_for_review' then 2 when 'approved' then 3
             when 'locked' then 4 when 'paid' then 5 end;

  if v_old >= 4 and v_new < v_old then
    raise exception
      'Pay period is % and cannot be re-opened (attempted %). Raise a payroll adjustment instead.',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function payroll.assert_period_status_forward_only() is
  'A pay period cannot be created already locked or paid, and cannot move backwards once locked or paid. Forward transition ORDER (approve before lock, lock before paid) is enforced in the API service layer, not here.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_periods_status_insert_ratchet'
      and tgrelid = 'payroll.pay_periods'::regclass
  ) then
    create trigger payroll_pay_periods_status_insert_ratchet
      before insert on payroll.pay_periods
      for each row execute function payroll.assert_period_status_forward_only();
  end if;
end
$$;

-- =============================================================================
-- 9. greater_of_winner must be able to name a revenue split
-- =============================================================================
-- payroll.pay_stage_type_enum includes 'revenue_split', and
-- pay_structure_stages.in_greater_of_comparison can be set on any stage - so a
-- chair-renter or hybrid model comparing a guaranteed minimum against their
-- revenue split is expressible as RULES. But pay_summaries.greater_of_winner is
-- CHECK-constrained to ('base_pay','commission') only (0073:402-403), so such a
-- comparison cannot record which side won, and principle 2's "both sides of a
-- comparison survive" fails for exactly the arrangement the settlement statement
-- exists to serve.
--
-- Widening only - every value previously valid stays valid.
--
-- ⚠️ NAME CARE: the target here is the INLINE column check from 0073:402-403,
-- which PostgreSQL auto-named `pay_summaries_greater_of_winner_check`. Do NOT
-- touch `pay_summaries_greater_of_winner` (0073:426-427) - that is a different,
-- still-wanted constraint asserting that an applied comparison always records a
-- winner. The replacement is given its own name to keep the two distinct.

alter table payroll.pay_summaries
  drop constraint if exists pay_summaries_greater_of_winner_check;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'pay_summaries_greater_of_winner_values'
      and conrelid = 'payroll.pay_summaries'::regclass
  ) then
    alter table payroll.pay_summaries
      add constraint pay_summaries_greater_of_winner_values
      check (
        greater_of_winner is null
        or greater_of_winner in ('base_pay', 'commission', 'revenue_split')
      );
  end if;
end
$$;

comment on column payroll.pay_summaries.greater_of_winner is
  'Which side won a greater-of comparison. Limited to the stage types that can actually be operands: base pay, commission, or a revenue split (chair-renter and hybrid models).';
