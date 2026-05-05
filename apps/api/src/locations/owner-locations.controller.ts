import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  BusinessLocation,
  LocationDetailResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateLocationDto, UpdateLocationDto } from './dto';
import { LocationsService } from './locations.service';

/**
 * Owner-only writes. Lives under `/owner/locations` for parity with the
 * `/owner/staff` and `/owner/onboarding` modules — the prefix itself acts as
 * a safety net even if the role guard regresses.
 */
@Controller('owner/locations')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner')
export class OwnerLocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Post()
  async create(
    @CurrentUser() actor: AuthUser,
    @Body() body: CreateLocationDto,
  ): Promise<LocationDetailResponse> {
    const location = await this.locations.create(actor, body);
    return { location };
  }

  @Patch(':id')
  async update(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
    @Body() body: UpdateLocationDto,
  ): Promise<LocationDetailResponse> {
    const location = await this.locations.update(actor, id, body);
    return { location };
  }

  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  async deactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<LocationDetailResponse> {
    const location: BusinessLocation = await this.locations.deactivate(actor, id);
    return { location };
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(
    @CurrentUser() actor: AuthUser,
    @Param('id') id: string,
  ): Promise<LocationDetailResponse> {
    const location: BusinessLocation = await this.locations.reactivate(actor, id);
    return { location };
  }
}
