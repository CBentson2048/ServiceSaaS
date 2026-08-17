import { ForbiddenException, Injectable } from '@nestjs/common';
import { userHasJoinedSalon, userHasRole } from '@sheer/domain';
import type { AuthUser } from '@sheer/domain';
import type { ZacAskRequestDto } from '../dto/zac-ask-request.dto';
import type { ZacActingContext, ZacRoleContext } from './zac-context.types';

@Injectable()
export class ZacContextService {
  /**
   * Resolve the acting-user context for one ZAC turn from the guard-verified actor.
   * Fail-closed: a salon-less account or an out-of-scope location is rejected here,
   * before any role profile, tool registry or model work happens.
   */
  resolve(
    actor: AuthUser,
    request: Pick<ZacAskRequestDto, 'locationId' | 'requestSource'>,
  ): ZacActingContext {
    if (!userHasJoinedSalon(actor)) {
      throw new ForbiddenException('ZAC is only available inside a salon account');
    }

    return {
      actorUserId: actor.id,
      actorFirstName: this.resolveFirstName(actor),
      businessId: actor.businessId,
      businessName: actor.businessName?.trim() || null,
      locationId: this.resolveLocationId(actor, request.locationId),
      accessibleLocationIds: [...actor.allowedLocationIds],
      accessibleLocations: this.resolveAccessibleLocations(actor),
      roleContext: this.resolveRoleContext(actor),
      roles: [...actor.roles],
      permissions: [...actor.permissions],
      staffProfileId: actor.staffProfileId ?? null,
      requestSource: request.requestSource ?? 'web_dashboard',
      timezone: actor.timezone ?? 'Europe/London',
      locale: 'en-GB',
      // Refined after conversation resolution; true keeps stateless turns
      // greeting exactly as they always have.
      firstAssistantTurn: true,
    };
  }

  /**
   * Safe id+name pairs for the locations the actor may see. Owners see the
   * business's locations; everyone else is filtered to allowedLocationIds —
   * other locations never enter the context, so no tool can name them.
   */
  private resolveAccessibleLocations(actor: AuthUser): { id: string; name: string }[] {
    const locations = userHasRole(actor, 'owner')
      ? actor.locations
      : actor.locations.filter((location) => actor.allowedLocationIds.includes(location.id));
    return locations.map((location) => ({ id: location.id, name: location.name }));
  }

  /** First name for greeting copy; null (neutral greeting) when nothing safe is available. */
  private resolveFirstName(actor: AuthUser): string | null {
    const firstName = actor.profile.firstName?.trim();
    if (firstName) return firstName;
    const fromFullName = actor.profile.fullName?.trim().split(/\s+/)[0];
    return fromFullName || null;
  }

  private resolveRoleContext(actor: AuthUser): ZacRoleContext {
    if (userHasRole(actor, 'owner')) return 'owner';
    if (userHasRole(actor, 'manager')) return 'manager';
    if (userHasRole(actor, 'stylist')) return 'stylist';
    throw new ForbiddenException('ZAC is not available for this role');
  }

  private resolveLocationId(actor: AuthUser, requestedLocationId?: string): string | null {
    if (!requestedLocationId) {
      return null;
    }

    if (userHasRole(actor, 'owner')) {
      const businessLocationIds = actor.locations.map((location) => location.id);
      if (!businessLocationIds.includes(requestedLocationId)) {
        throw new ForbiddenException('Location is outside your business');
      }
      return requestedLocationId;
    }

    if (!actor.allowedLocationIds.includes(requestedLocationId)) {
      throw new ForbiddenException('Location is outside your ZAC scope');
    }
    return requestedLocationId;
  }
}
