import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { DEVICE_PLATFORMS, type DevicePlatform } from '@sheer/domain';

/**
 * Request contracts for the in-app notification API.
 *
 * NOTE WHAT IS ABSENT: there is no `userId` on any of these. Recipient identity is
 * taken from the authenticated actor in every single case, so no request can ask
 * for — or write to — another user's feed. That is a deliberate contract decision,
 * not an omission; see the controller doc block.
 */

export class ListNotificationsQueryDto {
  /**
   * Unread only. Absent means the whole feed — the bell opens on everything with
   * unread highlighted, and the badge count is returned separately regardless.
   *
   * Parsed from the query string, so the raw value is text: 'true'/'1' are true and
   * everything else false. A bare `?unreadOnly` (empty string) is treated as true,
   * matching how flags are conventionally passed.
   */
  @IsOptional()
  @Transform(({ value }) => {
    // `undefined` MUST stay `undefined`. Whether class-transformer runs a
    // @Transform for a key absent from the query string is version- and
    // config-dependent; if it ever does, collapsing undefined to `true` here would
    // silently make the DEFAULT feed unread-only — the bell would stop showing read
    // history and no test that calls the service directly would catch it.
    if (value === undefined || value === null) return undefined;
    if (typeof value === 'boolean') return value;
    // A bare `?unreadOnly` arrives as '' and conventionally means "on".
    if (value === '') return true;
    return ['true', '1', 'yes'].includes(String(value).toLowerCase());
  })
  @IsBoolean()
  unreadOnly?: boolean;

  /** 1-based page index. Defaults to 1 when omitted. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  /** Rows per page. Clamped server-side to [1, 50]. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number;
}

export class RegisterDeviceDto {
  /**
   * Stable per-installation identifier the app generates once and keeps in secure
   * storage — apps/sheer-app has neither expo-device nor expo-application, so there
   * is no platform-provided installation id to use instead. Identifies the DEVICE
   * across push-token rotations, so a reinstall updates one row rather than
   * accumulating dead ones.
   */
  @IsString()
  @MinLength(8)
  @MaxLength(255)
  deviceIdentifier!: string;

  @IsIn(DEVICE_PLATFORMS)
  platform!: DevicePlatform;

  /**
   * APNs/FCM/Expo token. Optional: the app registers the device on sign-in and may
   * only receive a token later (or never, if the user declines the OS prompt).
   * Omitting it on a re-registration PRESERVES the stored token rather than
   * clearing it — see comms.register_user_device.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(512)
  pushToken?: string;
}
