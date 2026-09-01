import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsUUID, Matches, Max, Min } from 'class-validator';
import { OPERATIONAL_SIGNAL_BOUNDS, type OperationalSignalThresholds } from '@sheer/domain';

const B = OPERATIONAL_SIGNAL_BOUNDS;

class SpendThresholdsDto {
  @IsInt() @Min(B.spendWindowVisits.min) @Max(B.spendWindowVisits.max) @Type(() => Number)
  windowVisits!: number;

  @IsInt() @Min(B.spendMaterialityPercent.min) @Max(B.spendMaterialityPercent.max) @Type(() => Number)
  materialityPercent!: number;
}

class NoShowThresholdsDto {
  @IsInt() @Min(B.noShowLookbackDays.min) @Max(B.noShowLookbackDays.max) @Type(() => Number)
  lookbackDays!: number;

  @IsInt() @Min(B.noShowMinimumRelevantAppointments.min) @Max(B.noShowMinimumRelevantAppointments.max) @Type(() => Number)
  minimumRelevantAppointments!: number;

  @IsInt() @Min(B.noShowMediumRatePercent.min) @Max(B.noShowMediumRatePercent.max) @Type(() => Number)
  mediumRatePercent!: number;

  @IsInt() @Min(B.noShowHighRatePercent.min) @Max(B.noShowHighRatePercent.max) @Type(() => Number)
  highRatePercent!: number;

  @IsInt() @Min(B.noShowHighNoShowCount.min) @Max(B.noShowHighNoShowCount.max) @Type(() => Number)
  highNoShowCount!: number;

  @IsInt() @Min(B.noShowMediumLateCancellationCount.min) @Max(B.noShowMediumLateCancellationCount.max) @Type(() => Number)
  mediumLateCancellationCount!: number;
}

class ColourThresholdsDto {
  @IsInt() @Min(B.colourMinimumBufferMinutes.min) @Max(B.colourMinimumBufferMinutes.max) @Type(() => Number)
  minimumBufferMinutes!: number;
}

class SlotGapThresholdsDto {
  @IsInt() @Min(B.slotGapMinimumGapMinutes.min) @Max(B.slotGapMinimumGapMinutes.max) @Type(() => Number)
  minimumGapMinutes!: number;
}

/**
 * Sensitivity thresholds for all four signals, set together as one scope.
 *
 * Bounds are declared here, in `OPERATIONAL_SIGNAL_BOUNDS` and in the CHECK
 * constraints of migration 0106 — the same numbers in all three places, so an
 * impossible value is rejected whichever door it arrives through. The
 * cross-field rule (medium rate <= high rate) is enforced by
 * `validateOperationalSignalThresholds` in the service and by a CHECK in 0106.
 *
 * `businessId` appears nowhere: it comes from the authenticated context.
 */
export class UpsertOperationalSignalSettingsDto implements OperationalSignalThresholds {
  /** Omitted / null = the business-wide default. */
  @IsOptional()
  @IsUUID()
  locationId?: string | null;

  @IsObject() @Type(() => SpendThresholdsDto)
  spend!: SpendThresholdsDto;

  @IsObject() @Type(() => NoShowThresholdsDto)
  noShow!: NoShowThresholdsDto;

  @IsObject() @Type(() => ColourThresholdsDto)
  colour!: ColourThresholdsDto;

  @IsObject() @Type(() => SlotGapThresholdsDto)
  slotGap!: SlotGapThresholdsDto;
}

export class DiarySignalsQueryDto {
  @IsUUID()
  locationId!: string;

  /** Salon-local day, `YYYY-MM-DD`. Defaults to today in the location's zone. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
