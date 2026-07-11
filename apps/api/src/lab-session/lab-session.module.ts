import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabSessionController } from './lab-session.controller';
import { LabSessionService } from './lab-session.service';

@Module({
  imports: [AuthModule],
  controllers: [LabSessionController],
  providers: [LabSessionService],
  exports: [LabSessionService],
})
export class LabSessionModule {}
