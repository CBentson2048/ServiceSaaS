-- Appointment Book users need read-only access to the service catalogue and
-- rota coverage without receiving permission to edit either feature.

update core.security_levels
set permissions = permissions || '["services.view"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist', 'stylist')
  and not permissions @> '["services.view"]'::jsonb;

update core.security_levels
set permissions = permissions || '["rota.view"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist', 'stylist')
  and not permissions @> '["rota.view"]'::jsonb;
