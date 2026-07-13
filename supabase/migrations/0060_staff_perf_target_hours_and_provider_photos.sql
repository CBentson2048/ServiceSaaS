-- 0060_staff_perf_target_hours_and_provider_photos.sql
-- Wrike #4507280825 — Luke Ormsby review follow-ups on the staff record fields:
--   1. Pro-rated performance target should scale by HOURS worked (vs contracted
--      hours), not days — the fairest basis.
--   2. Provider photo should be an uploaded image the system stores (drag & drop),
--      not a manually-pasted URL. Create the storage bucket that backs it.

-- ---------------------------------------------------------------------------
-- 1. Performance target mode is now hours-based (documentation only; the enum
--    value 'pro_rated' is unchanged, the pay engine scales by hours worked).
-- ---------------------------------------------------------------------------
comment on column core.staff_profiles.performance_target_mode is
  'How performance_target_amount is applied: flat (as entered) or pro_rated (scaled by hours actually worked vs the member''s contracted hours by the pay engine).';

-- ---------------------------------------------------------------------------
-- 2. Provider photo storage bucket.
--    Public-read so internal + client-facing Salon Suite can render the image
--    via its public URL. Uploads are performed by the API service role (which
--    bypasses storage RLS), so no authenticated write policy is required here.
--    Server-side guards: JPEG/PNG/WebP only, 5 MB max.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'provider-photos',
  'provider-photos',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
