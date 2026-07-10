import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type {
  AuthUser,
  Permission,
  SecurityLevel,
  SecurityLevelBaseRole,
} from '@sheer/domain';
import { ALL_PERMISSIONS, SYSTEM_SECURITY_LEVELS, userHasRole } from '@sheer/domain';
import type { CreateSecurityLevelDto, UpdateSecurityLevelDto } from './dto';

interface SecurityLevelRow {
  id: string;
  business_id: string;
  key: string | null;
  name: string;
  description: string | null;
  base_role: SecurityLevelBaseRole;
  is_system: boolean;
  permissions: unknown;
  created_at: string;
  updated_at: string;
}

const VALID_PERMISSIONS = new Set<string>(ALL_PERMISSIONS);

// System levels ordered highest-privilege first for stable UI output.
const SYSTEM_LEVEL_ORDER: Record<string, number> = {
  owner: 0,
  group_admin: 1,
  manager: 2,
  receptionist: 3,
  stylist: 4,
};

@Injectable()
export class OwnerSecurityLevelsService {
  private readonly logger = new Logger(OwnerSecurityLevelsService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async list(actor: AuthUser): Promise<SecurityLevel[]> {
    this.assertOwner(actor);
    await this.ensureSystemLevels(actor.businessId);

    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .select('*')
      .eq('business_id', actor.businessId)
      .returns<SecurityLevelRow[]>();

    if (error) {
      this.logger.error(`list security levels failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load security levels');
    }

    return (data ?? []).map((row) => this.toSecurityLevel(row)).sort(compareLevels);
  }

  async create(actor: AuthUser, dto: CreateSecurityLevelDto): Promise<SecurityLevel> {
    this.assertOwner(actor);

    const name = dto.name.trim();
    const permissions = this.sanitisePermissions(dto.permissions);

    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .insert({
        business_id: actor.businessId,
        key: null,
        name,
        description: dto.description?.trim() || null,
        base_role: dto.baseRole,
        is_system: false,
        permissions,
      })
      .select('*')
      .single<SecurityLevelRow>();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('A security level with that name already exists');
      }
      this.logger.error(`create security level failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to create security level');
    }

    return this.toSecurityLevel(data);
  }

  async update(actor: AuthUser, id: string, dto: UpdateSecurityLevelDto): Promise<SecurityLevel> {
    this.assertOwner(actor);
    const existing = await this.fetchLevel(actor.businessId, id);

    if (existing.is_system) {
      throw new BadRequestException('System security levels cannot be edited');
    }

    const patch: Record<string, unknown> = {};
    if (dto.name !== undefined) patch.name = dto.name.trim();
    if (dto.description !== undefined) patch.description = dto.description?.trim() || null;
    if (dto.permissions !== undefined) patch.permissions = this.sanitisePermissions(dto.permissions);

    if (Object.keys(patch).length === 0) {
      return this.toSecurityLevel(existing);
    }

    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .update(patch)
      .eq('id', id)
      .eq('business_id', actor.businessId)
      .select('*')
      .single<SecurityLevelRow>();

    if (error) {
      if (error.code === '23505') {
        throw new ConflictException('A security level with that name already exists');
      }
      this.logger.error(`update security level failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to update security level');
    }

    return this.toSecurityLevel(data);
  }

  async remove(actor: AuthUser, id: string): Promise<void> {
    this.assertOwner(actor);
    const existing = await this.fetchLevel(actor.businessId, id);

    if (existing.is_system) {
      throw new BadRequestException('System security levels cannot be deleted');
    }

    // Members keep their base role; the FK is ON DELETE SET NULL so they fall
    // back to base-role defaults.
    const { error } = await this.admin
      .schema('core')
      .from('security_levels')
      .delete()
      .eq('id', id)
      .eq('business_id', actor.businessId);

    if (error) {
      this.logger.error(`delete security level failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to delete security level');
    }
  }

  /**
   * Ensure the built-in system levels exist for a business (idempotent). Covers
   * businesses created after migration 0055 without touching the onboarding RPC.
   */
  async ensureSystemLevels(businessId: string): Promise<void> {
    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .select('key')
      .eq('business_id', businessId)
      .eq('is_system', true)
      .returns<{ key: string | null }[]>();

    if (error) {
      this.logger.error(`ensureSystemLevels read failed: ${error.message}`);
      return;
    }

    const existing = new Set((data ?? []).map((r) => r.key));
    const missing = SYSTEM_SECURITY_LEVELS.filter((level) => !existing.has(level.key));
    if (missing.length === 0) return;

    const rows = missing.map((level) => ({
      business_id: businessId,
      key: level.key,
      name: level.name,
      description: level.description,
      base_role: level.baseRole,
      is_system: true,
      permissions: level.permissions,
    }));

    const { error: insertError } = await this.admin
      .schema('core')
      .from('security_levels')
      .insert(rows);

    if (insertError && insertError.code !== '23505') {
      this.logger.error(`ensureSystemLevels insert failed: ${insertError.message}`);
    }
  }

  // ---------------------------------------------------------------------------

  private async fetchLevel(businessId: string, id: string): Promise<SecurityLevelRow> {
    const { data, error } = await this.admin
      .schema('core')
      .from('security_levels')
      .select('*')
      .eq('id', id)
      .eq('business_id', businessId)
      .maybeSingle<SecurityLevelRow>();

    if (error) {
      this.logger.error(`fetch security level failed: ${error.message}`);
      throw new InternalServerErrorException('Unable to load security level');
    }
    if (!data) {
      throw new NotFoundException('Security level not found');
    }
    return data;
  }

  private sanitisePermissions(permissions: readonly Permission[]): Permission[] {
    const filtered = permissions.filter((p) => VALID_PERMISSIONS.has(p));
    // Preserve catalogue order for stable storage/output.
    return ALL_PERMISSIONS.filter((p) => filtered.includes(p));
  }

  private toSecurityLevel(row: SecurityLevelRow): SecurityLevel {
    const permissions = Array.isArray(row.permissions)
      ? (row.permissions.filter(
          (p): p is Permission => typeof p === 'string' && VALID_PERMISSIONS.has(p),
        ))
      : [];
    return {
      id: row.id,
      businessId: row.business_id,
      key: (row.key as SecurityLevel['key']) ?? null,
      name: row.name,
      description: row.description,
      baseRole: row.base_role,
      isSystem: row.is_system,
      permissions: ALL_PERMISSIONS.filter((p) => permissions.includes(p)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private assertOwner(actor: AuthUser): void {
    if (!userHasRole(actor, 'owner')) {
      throw new ForbiddenException('Only owners can manage security levels');
    }
  }
}

function compareLevels(a: SecurityLevel, b: SecurityLevel): number {
  if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
  if (a.isSystem && b.isSystem) {
    return (SYSTEM_LEVEL_ORDER[a.key ?? ''] ?? 99) - (SYSTEM_LEVEL_ORDER[b.key ?? ''] ?? 99);
  }
  return a.name.localeCompare(b.name);
}
