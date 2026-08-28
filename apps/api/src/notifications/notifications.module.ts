import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ArrivalNotificationService } from './arrival-notification.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { UserDevicesService } from './user-devices.service';

/**
 * The in-app notification foundation.
 *
 * Everything is exported, deliberately. Producers live in their own modules
 * (lab-appointments today; ordering, stock and ZAC later) and must be able to import
 * this one rather than reaching for the database themselves — a producer that cannot
 * inject the service will grow its own notification table, which is exactly the
 * outcome this ticket exists to prevent.
 *
 * Contrast CommunicationsModule, which does NOT export its dispatcher or subject
 * registry; that keeps the outbound queue private on purpose. Here the service IS
 * the public contract.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, UserDevicesService, ArrivalNotificationService],
  exports: [NotificationsService, UserDevicesService, ArrivalNotificationService],
})
export class NotificationsModule {}
