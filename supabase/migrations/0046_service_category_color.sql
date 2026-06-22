-- 0046_service_category_color.sql
-- Adds a configurable colour to each service category so the appointment book
-- can paint each booking tile by its service category, letting owners/managers
-- see at a glance which categories are booked. Nullable: categories without a
-- colour fall back to a neutral tile on the calendar. Stored as a #RRGGBB hex
-- string (mirrors core.staff_profiles.color_hex).

alter table booking.service_categories
  add column if not exists color_hex text;

alter table booking.service_categories
  drop constraint if exists service_categories_color_hex_format;
alter table booking.service_categories
  add constraint service_categories_color_hex_format
  check (color_hex is null or color_hex ~* '^#[0-9a-f]{6}$');

comment on column booking.service_categories.color_hex is
  '#RRGGBB tile colour for the appointment book, or null for the neutral default.';
