import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  AuthUser,
  GetCancellationPolicyResponse,
  UpdateCancellationPolicyResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { UpdateCancellationPolicyDto } from './dto';
import { OwnerCancellationPolicyService } from './owner-cancellation-policy.service';

@Controller('owner/cancellation-policy')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@RequireRoles('owner', 'manager')
export class OwnerCancellationPolicyController {
  constructor(private readonly service: OwnerCancellationPolicyService) {}

  @Get()
  async getPolicy(
    @CurrentUser() actor: AuthUser,
    @Query('locationId') locationId: string,
  ): Promise<GetCancellationPolicyResponse> {
    if (!locationId) {
      throw new BadRequestException('locationId query parameter is required');
    }
    return { settings: await this.service.getPolicy(actor, locationId) };
  }

  @Patch()
  async updatePolicy(
    @CurrentUser() actor: AuthUser,
    @Body() body: UpdateCancellationPolicyDto,
  ): Promise<UpdateCancellationPolicyResponse> {
    return { settings: await this.service.updatePolicy(actor, body) };
  }
}
