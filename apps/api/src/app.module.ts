import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { LabAppointmentsModule } from './lab-appointments/lab-appointments.module';
import { LabDeviceModule } from './lab-device/lab-device.module';
import { LabFormulaModule } from './lab-formula/lab-formula.module';
import { LabPinModule } from './lab-pin/lab-pin.module';
import { LabSessionModule } from './lab-session/lab-session.module';
import { validateEnv } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env.local', '.env'],
    }),
    AuthModule,
    HealthModule,
    LabDeviceModule,
    LabSessionModule,
    LabPinModule,
    LabAppointmentsModule,
    LabFormulaModule,
  ],
})
export class AppModule {}
