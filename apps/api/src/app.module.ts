import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { RequestResponseLoggingMiddleware } from './common/request-response-logging.middleware';
import { CrmModule } from './crm/crm.module';
import { HealthModule } from './health/health.module';
import { LabAppointmentsModule } from './lab-appointments/lab-appointments.module';
import { LabDeviceModule } from './lab-device/lab-device.module';
import { LabFormulaModule } from './lab-formula/lab-formula.module';
import { LabPinModule } from './lab-pin/lab-pin.module';
import { LabSessionModule } from './lab-session/lab-session.module';
import { LocationsModule } from './locations/locations.module';
import { OwnerBookingSettingsModule } from './owner-booking-settings/owner-booking-settings.module';
import { OwnerOnboardingModule } from './owner-onboarding/owner-onboarding.module';
import { PublicBookingModule } from './public-booking/public-booking.module';
import { RotaModule } from './rota/rota.module';
import { StaffModule } from './staff/staff.module';
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
    OwnerOnboardingModule,
    StaffModule,
    LocationsModule,
    OwnerBookingSettingsModule,
    PublicBookingModule,
    CrmModule,
    RotaModule,
    HealthModule,
    LabDeviceModule,
    LabSessionModule,
    LabPinModule,
    LabAppointmentsModule,
    LabFormulaModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestResponseLoggingMiddleware).forRoutes('*');
  }
}
