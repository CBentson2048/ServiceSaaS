import { Body, Controller, Get, Headers, Post, UseGuards } from '@nestjs/common';
import type { AuthUser } from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { RequireRoles, RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { PairScaleDto, RegisterLabDeviceDto, RevokeLabDeviceDto } from './dto';
import { LabDeviceService } from './lab-device.service';

@Controller('lab/device')
export class LabDeviceController {
  constructor(private readonly labDeviceService: LabDeviceService) {}

  @Post('register')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @RequireRoles('owner', 'manager')
  register(@CurrentUser() actor: AuthUser, @Body() dto: RegisterLabDeviceDto) {
    return this.labDeviceService.register(actor, dto);
  }

  @Get('list')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @RequireRoles('owner', 'manager')
  list(@CurrentUser() actor: AuthUser) {
    return this.labDeviceService.list(actor);
  }

  @Post('revoke')
  @UseGuards(SupabaseAuthGuard, RolesGuard)
  @RequireRoles('owner', 'manager')
  revoke(@CurrentUser() actor: AuthUser, @Body() dto: RevokeLabDeviceDto) {
    return this.labDeviceService.revoke(actor, dto);
  }

  @Get('status')
  getStatus() {
    return this.labDeviceService.getStatus();
  }

  @Get('resolve')
  resolve(@Headers('authorization') authorization?: string) {
    return this.labDeviceService.resolve(readBearerToken(authorization));
  }

  @Post('pair-scale')
  pairScale(@Body() dto: PairScaleDto) {
    return this.labDeviceService.pairScale(dto);
  }

  @Post('unpair-scale')
  unpairScale() {
    return this.labDeviceService.unpairScale();
  }
}

function readBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith('Bearer ')) return undefined;
  return authorization.slice('Bearer '.length).trim() || undefined;
}
