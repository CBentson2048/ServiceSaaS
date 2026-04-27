-- 0001_extensions_and_helpers.sql
-- Shared extensions and utility helpers for later migrations.

create schema if not exists extensions;

create extension if not exists pgcrypto with schema extensions;
create extension if not exists citext with schema extensions;
create extension if not exists btree_gist with schema extensions;

comment on schema extensions is 'Managed PostgreSQL extensions used by the Sheer Platform.';

create or replace function public.current_user_id()
returns uuid
language sql
stable
as $$
  select auth.uid()
$$;

comment on function public.current_user_id() is
  'Wrapper around auth.uid() so policy code stays readable.';

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'Before update trigger helper for mutable business tables.';
