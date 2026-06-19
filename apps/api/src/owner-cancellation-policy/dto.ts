import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class UpdateCancellationPolicyDto {
  @IsUUID()
  locationId!: string;

  /**
   * Whole days before the appointment start that a customer may cancel (with a
   * deposit refund) or rebook. 0 means every cancellation falls inside the window
   * (deposit forfeited). Capped to a sane upper bound.
   */
  @IsInt()
  @Min(0)
  @Max(60)
  cancellationWindowDays!: number;
}
