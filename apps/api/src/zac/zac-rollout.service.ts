import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@sheer/domain';

/**
 * Controlled rollout for the ZAC dark launch. Entry requires, in order: the
 * global `ZAC_ENABLED` flag → the optional per-business allowlist → the
 * `zac.access` permission (controller guards) → each tool's own underlying
 * permission (registry/dispatch). Rollout failures read as 404, not 403 — a
 * dark-launched route stays invisible.
 */
@Injectable()
export class ZacRolloutService {
  constructor(private readonly config: ConfigService) {}

  /** ZAC exists only when ZAC_ENABLED is exactly 'true'. Defaults off. */
  isGloballyEnabled(): boolean {
    return this.config.get<string>('ZAC_ENABLED') === 'true';
  }

  /** Unset/empty allowlist = no business restriction; otherwise membership required. */
  isBusinessAllowed(businessId: string): boolean {
    const allowlist = this.parseAllowlist();
    return allowlist === null || allowlist.has(businessId);
  }

  /** Throws the dark-launch 404 unless both the global flag and the allowlist pass. */
  assertRolloutFor(actor: Pick<AuthUser, 'businessId'>): void {
    if (!this.isGloballyEnabled() || !this.isBusinessAllowed(actor.businessId)) {
      throw new NotFoundException();
    }
  }

  private parseAllowlist(): Set<string> | null {
    const raw = this.config.get<string>('ZAC_ALLOWED_BUSINESS_IDS');
    if (!raw) return null;
    const ids = raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    return ids.length > 0 ? new Set(ids) : null;
  }
}
