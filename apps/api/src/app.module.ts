import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AccountModule } from './account/account.module';
import { AuthModule } from './auth/auth.module';
import { CommunicationsModule } from './communications/communications.module';
import { RequestResponseLoggingMiddleware } from './common/request-response-logging.middleware';
import { CrmModule } from './crm/crm.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { HealthModule } from './health/health.module';
import { InventoryModule } from './inventory/inventory.module';
import { LabAppointmentsModule } from './lab-appointments/lab-appointments.module';
import { LabBillingRulesModule } from './lab-billing-rules/lab-billing-rules.module';
import { LabAnalyticsModule } from './lab-analytics/lab-analytics.module';
import { LabDeviceModule } from './lab-device/lab-device.module';
import { LabFormulaModule } from './lab-formula/lab-formula.module';
import { LabPinModule } from './lab-pin/lab-pin.module';
import { LabSessionModule } from './lab-session/lab-session.module';
import { KpiModule } from './kpi/kpi.module';
import { LocationsModule } from './locations/locations.module';
import { MobileDashboardModule } from './mobile-dashboard/mobile-dashboard.module';
import { OwnerBillingSettingsModule } from './owner-billing-settings/owner-billing-settings.module';
import { OwnerBookingSettingsModule } from './owner-booking-settings/owner-booking-settings.module';
import { OwnerCancellationPolicyModule } from './owner-cancellation-policy/owner-cancellation-policy.module';
import { OwnerTaxSettingsModule } from './owner-tax-settings/owner-tax-settings.module';
import { OwnerOnboardingModule } from './owner-onboarding/owner-onboarding.module';
import { ProfileModule } from './profile/profile.module';
import { PublicBookingModule } from './public-booking/public-booking.module';
import { RetailSalesModule } from './retail-sales/retail-sales.module';
import { RotaModule } from './rota/rota.module';
import { SalonDirectoryModule } from './salon-directory/salon-directory.module';
import { ServicesModule } from './services/services.module';
import { StaffModule } from './staff/staff.module';
import { StaffBookingModule } from './staff-booking/staff-booking.module';
import { TwilioModule } from './twilio/twilio.module';
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
    AccountModule,
    CommunicationsModule,
    OwnerOnboardingModule,
    ProfileModule,
    StaffModule,
    LocationsModule,
    OwnerBookingSettingsModule,
    OwnerBillingSettingsModule,
    OwnerTaxSettingsModule,
    OwnerCancellationPolicyModule,
    PublicBookingModule,
    SalonDirectoryModule,
    StaffBookingModule,
    TwilioModule,
    CrmModule,
    DashboardModule,
    KpiModule,
    RetailSalesModule,
    RotaModule,
    ServicesModule,
    InventoryModule,
    HealthModule,
    MobileDashboardModule,
    LabDeviceModule,
    LabSessionModule,
    LabPinModule,
    LabAppointmentsModule,
    LabAnalyticsModule,
    LabFormulaModule,
    LabBillingRulesModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestResponseLoggingMiddleware).forRoutes('*');
  }
}
