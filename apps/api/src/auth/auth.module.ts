import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LocationScopeGuard } from './location-scope.guard';
import { PermissionsGuard } from './permissions.guard';
import { RolesGuard } from './roles.guard';
import { StylistSelfGuard } from './stylist-self.guard';
import { SupabaseAuthGuard } from './supabase-auth.guard';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [EmailModule],
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthGuard, RolesGuard, PermissionsGuard, LocationScopeGuard, StylistSelfGuard],
  exports: [AuthService, SupabaseAuthGuard, RolesGuard, PermissionsGuard, LocationScopeGuard, StylistSelfGuard],
})
export class AuthModule {}
