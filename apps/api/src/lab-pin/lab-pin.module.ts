import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LabPinController } from './lab-pin.controller';
import { LabPinService } from './lab-pin.service';

@Module({
  imports: [AuthModule],
  controllers: [LabPinController],
  providers: [LabPinService],
})
export class LabPinModule {}
