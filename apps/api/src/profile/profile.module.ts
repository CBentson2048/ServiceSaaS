import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabFormulaModule } from '../lab-formula/lab-formula.module';
import { MobileDashboardModule } from '../mobile-dashboard/mobile-dashboard.module';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

@Module({
  imports: [AuthModule, LabFormulaModule, MobileDashboardModule],
  controllers: [ProfileController],
  providers: [ProfileService],
  exports: [ProfileService],
})
export class ProfileModule {}
