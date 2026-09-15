import { HttpException, HttpStatus } from '@nestjs/common';
import type { ReportErrorBody, ReportErrorCode, ReportFilterIssue } from '@sheer/domain';

const STATUS: Record<ReportErrorCode, number> = {
  report_not_found: HttpStatus.NOT_FOUND,
  report_forbidden: HttpStatus.FORBIDDEN,
  report_filter_invalid: HttpStatus.BAD_REQUEST,
  report_control_not_supported: HttpStatus.BAD_REQUEST,
  report_location_out_of_scope: HttpStatus.FORBIDDEN,
  report_no_locations_in_scope: HttpStatus.FORBIDDEN,
  report_timezone_invalid: HttpStatus.UNPROCESSABLE_ENTITY,
  report_week_start_unconfigured: HttpStatus.CONFLICT,
  report_cursor_invalid: HttpStatus.BAD_REQUEST,
};

// Messages are fixed per code and never echo request values: an out-of-scope
// response must read the same whether the id is foreign, unknown or merely not
// permitted, or it becomes a probe for other businesses' locations.
const MESSAGE: Record<ReportErrorCode, string> = {
  report_not_found: 'Report not found',
  report_forbidden: 'You do not have access to this report',
  report_filter_invalid: 'The report filters are not valid',
  report_control_not_supported: 'This report does not support one of the requested controls',
  report_location_out_of_scope: 'One or more selected locations are not available to you for this report',
  report_no_locations_in_scope: 'You have no locations available for this report',
  report_timezone_invalid: 'A selected location has a time zone that needs fixing',
  report_week_start_unconfigured: 'This business has no week start configured',
  report_cursor_invalid: 'The report page cursor is not valid',
};

export function reportHttpError(
  code: ReportErrorCode,
  extra: { issues?: ReportFilterIssue[]; locationIds?: string[] } = {},
): HttpException {
  const body: ReportErrorBody = {
    statusCode: STATUS[code],
    code,
    message: MESSAGE[code],
    ...(extra.issues && extra.issues.length > 0 ? { issues: extra.issues } : {}),
    ...(extra.locationIds && extra.locationIds.length > 0 ? { locationIds: extra.locationIds } : {}),
  };
  return new HttpException(body, STATUS[code]);
}
