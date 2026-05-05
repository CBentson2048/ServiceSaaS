import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OwnerOnboardingController } from './owner-onboarding.controller';
import { OwnerOnboardingService } from './owner-onboarding.service';

@Module({
  imports: [AuthModule],
  controllers: [OwnerOnboardingController],
  providers: [OwnerOnboardingService],
  exports: [OwnerOnboardingService],
})
export class OwnerOnboardingModule {}
