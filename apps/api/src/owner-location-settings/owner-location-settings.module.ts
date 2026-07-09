import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerLocationSettingsController } from './owner-location-settings.controller';
import { OwnerLocationSettingsService } from './owner-location-settings.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnerLocationSettingsController],
  providers: [OwnerLocationSettingsService],
  exports: [OwnerLocationSettingsService],
})
export class OwnerLocationSettingsModule {}
