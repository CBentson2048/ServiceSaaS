import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ListLocationsResponse,
  LocationDetailResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { LocationsService } from './locations.service';

/**
 * Authenticated reads for owners and managers.
 *
 * Manager scoping is enforced inside the service (filters to
 * `actor.allowedLocationIds` and 403s on detail requests for foreign locations)
 * so the controller stays trivially simple.
 */
@Controller('locations')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  async list(@CurrentUser() actor: AuthUser): Promise<ListLocationsResponse> {
    return this.locations.listForActor(actor);
  }

  @Get(':id')
  async detail(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<LocationDetailResponse> {
    const location = await this.locations.getForActor(actor, id);
    return { location };
  }
}
