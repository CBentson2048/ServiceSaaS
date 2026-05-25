import { Module } from '@nestjs/common';
import { LabSessionController } from './lab-session.controller';
import { LabSessionService } from './lab-session.service';

@Module({
  controllers: [LabSessionController],
  providers: [LabSessionService],
  exports: [LabSessionService],
})
export class LabSessionModule {}
