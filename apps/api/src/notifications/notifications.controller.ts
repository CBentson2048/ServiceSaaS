import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import type {
  AuthUser,
  ListNotificationsResponse,
  ListUserDevicesResponse,
  MarkAllNotificationsReadResponse,
  MarkNotificationResponse,
  RegisterUserDeviceResponse,
  UnreadCountResponse,
} from '@sheer/domain';
import { CurrentUser } from '../auth/current-user.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { ListNotificationsQueryDto, RegisterDeviceDto } from './dto';
import { NotificationsService } from './notifications.service';
import { UserDevicesService } from './user-devices.service';

/**
 * In-app notifications for the signed-in user (V1.1).
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO @RequireRoles AND NO @RequirePermissions
 * ---------------------------------------------------------------------------
 * This is not an oversight, and it is not a weaker guard than the rest of the API —
 * it is a different security model, and the correct one for a personal feed.
 *
 * Every other management endpoint gates a SHARED resource, so it asks "may this
 * role see this business's data?". A notification is not shared: visibility is
 * RECIPIENT-BASED. You can read a notification because it was addressed to you, and
 * for no other reason. Every method below derives the recipient from
 * `@CurrentUser()` and every query filters on `actor.id`, so:
 *
 *   - a stylist reads their own notifications and no one else's;
 *   - an OWNER, despite holding every permission in the business, does NOT thereby
 *     gain the ability to read an employee's personal feed — there is no request
 *     shape that widens the scope, and no permission that would;
 *   - there is no `?userId=` parameter anywhere, so impersonation is not expressible
 *     rather than merely forbidden.
 *
 * Adding a role guard would only mean "which roles have a feed at all", which is
 * every authenticated user. Authentication is therefore the whole gate here.
 * Migration 0099's RLS enforces the same recipient rule again at the database, for
 * direct PostgREST access that never passes through this controller.
 *
 * Notifications are CREATED by server-side producers (check-in, ordering, stock),
 * never by a client: there is deliberately no POST /notifications.
 */
@Controller('notifications')
@UseGuards(SupabaseAuthGuard)
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly devices: UserDevicesService,
  ) {}

  /** The acting user's feed, newest first. Paginated; `?unreadOnly=true` narrows it. */
  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query() query: ListNotificationsQueryDto,
  ): Promise<ListNotificationsResponse> {
    return this.notifications.list(actor, query);
  }

  /**
   * Just the badge. Declared before the parameterised routes so the literal segment
   * wins route matching.
   */
  @Get('unread-count')
  unreadCount(@CurrentUser() actor: AuthUser): Promise<UnreadCountResponse> {
    return this.notifications.unreadCount(actor);
  }

  /** The acting user's registered devices. */
  @Get('devices')
  listDevices(@CurrentUser() actor: AuthUser): Promise<ListUserDevicesResponse> {
    return this.devices.list(actor);
  }

  /**
   * Register/refresh this device for future push. Idempotent — the app calls it on
   * every launch and on token rotation.
   */
  @Post('devices')
  registerDevice(
    @CurrentUser() actor: AuthUser,
    @Body() body: RegisterDeviceDto,
  ): Promise<RegisterUserDeviceResponse> {
    return this.devices.register(actor, body);
  }

  /** Stop notifying this device (sign-out). Keeps the row, clears the token. */
  @Delete('devices/:deviceId')
  disableDevice(
    @CurrentUser() actor: AuthUser,
    @Param('deviceId', new ParseUUIDPipe()) deviceId: string,
  ): Promise<RegisterUserDeviceResponse> {
    return this.devices.disable(actor, deviceId);
  }

  /** Clear the whole badge in one call. */
  @Post('read-all')
  markAllRead(@CurrentUser() actor: AuthUser): Promise<MarkAllNotificationsReadResponse> {
    return this.notifications.markAllRead(actor);
  }

  /**
   * Mark read. Affects ONLY the acting user's recipient row — a notification sent to
   * the Owner and the Manager stays unread for the Manager after the Owner reads it.
   */
  @Patch(':notificationId/read')
  markRead(
    @CurrentUser() actor: AuthUser,
    @Param('notificationId', new ParseUUIDPipe()) notificationId: string,
  ): Promise<MarkNotificationResponse> {
    return this.notifications.markRead(actor, notificationId);
  }

  /** Mark unread — read_at back to null, again only for the acting user. */
  @Patch(':notificationId/unread')
  markUnread(
    @CurrentUser() actor: AuthUser,
    @Param('notificationId', new ParseUUIDPipe()) notificationId: string,
  ): Promise<MarkNotificationResponse> {
    return this.notifications.markUnread(actor, notificationId);
  }
}
