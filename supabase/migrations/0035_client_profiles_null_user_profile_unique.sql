-- 0035_client_profiles_null_user_profile_unique.sql
-- Fix: manually-created CRM clients fail with a duplicate-key error on the
-- second insert per business. core.client_profiles was created (0003) with
-- `unique nulls not distinct (business_id, user_profile_id)`. CRM-created
-- clients never have a linked account, so user_profile_id is NULL. Under
-- NULLS NOT DISTINCT, all NULLs collide, so a business can hold at most one
-- unlinked client. Switch to the default NULLS DISTINCT (matching
-- core.staff_profiles) so unlimited unlinked clients are allowed while still
-- enforcing one client per linked user_profile per business.

alter table core.client_profiles
  drop constraint if exists client_profiles_business_id_user_profile_id_key;

alter table core.client_profiles
  add constraint client_profiles_business_id_user_profile_id_key
    unique (business_id, user_profile_id);
