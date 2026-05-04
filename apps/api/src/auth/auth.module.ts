import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocationScopeGuard } from './location-scope.guard';
import { RolesGuard } from './roles.guard';
import { StylistSelfGuard } from './stylist-self.guard';
import { SupabaseAuthGuard } from './supabase-auth.guard';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthGuard, RolesGuard, LocationScopeGuard, StylistSelfGuard],
  exports: [AuthService, SupabaseAuthGuard, RolesGuard, LocationScopeGuard, StylistSelfGuard],
})
export class AuthModule {}
