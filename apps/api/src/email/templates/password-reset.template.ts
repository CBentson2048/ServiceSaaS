export interface PasswordResetEmailInput {
  /** First name (or display name fragment) used in the greeting. Falls back to "there". */
  recipientName?: string;
  /** Fully-qualified URL to the reset-password page (already includes the token). */
  resetUrl: string;
  /** ISO timestamp the reset token expires at. */
  expiresAt: string;
  /** Best-effort request IP, surfaced in the email so the user can spot abuse. */
  requestIp?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND_COLOR = '#7B5BE8';
const BRAND_DARK = '#1F1B2E';
const MUTED = '#6B7280';
const BORDER = '#E5E7EB';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatExpiry(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString('en-GB', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export function renderPasswordResetEmail(input: PasswordResetEmailInput): RenderedEmail {
  const greeting = input.recipientName?.trim() || 'there';
  const expires = formatExpiry(input.expiresAt);
  const requestIp = input.requestIp?.trim();

  const subject = 'Reset your Sheer password';

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F5F4F8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND_DARK};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Reset your Sheer password. This link expires on ${escapeHtml(expires)}.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F4F8;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border:1px solid ${BORDER};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <div style="font-size:18px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.4px;">SHEER</div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 8px 32px;">
                <h1 style="margin:0;font-size:22px;line-height:30px;font-weight:600;color:${BRAND_DARK};">
                  Hi ${escapeHtml(greeting)}, reset your password.
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND_DARK};">
                  We received a request to reset the password for your Sheer account. Click the button below to set a new password.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="padding:8px 0 4px 0;">
                      <a href="${escapeHtml(input.resetUrl)}" target="_blank" rel="noopener noreferrer"
                         style="display:inline-block;background-color:${BRAND_COLOR};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:12px 24px;border-radius:9999px;">
                        Reset my password
                      </a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">
                  Or paste this link into your browser:<br />
                  <a href="${escapeHtml(input.resetUrl)}" style="color:${BRAND_COLOR};word-break:break-all;">${escapeHtml(input.resetUrl)}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <div style="border-top:1px solid ${BORDER};"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 4px 32px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">
                  This link expires on <strong>${escapeHtml(expires)}</strong> and can be used once.
                </p>
              </td>
            </tr>
            ${
              requestIp
                ? `<tr>
              <td style="padding:8px 32px 4px 32px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">
                  Request origin IP: <strong>${escapeHtml(requestIp)}</strong>.
                </p>
              </td>
            </tr>`
                : ''
            }
            <tr>
              <td style="padding:8px 32px 28px 32px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">
                  Didn't request a reset? You can safely ignore this email — your password will not change unless you click the link above.
                </p>
              </td>
            </tr>
          </table>
          <div style="max-width:560px;width:100%;margin:16px auto 0 auto;font-size:11px;line-height:16px;color:${MUTED};text-align:center;">
            Sent by Sheer.
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    `Hi ${greeting},`,
    '',
    'We received a request to reset the password for your Sheer account.',
    '',
    'Reset your password:',
    input.resetUrl,
    '',
    `This link expires on ${expires} and can be used once.`,
    requestIp ? `Request origin IP: ${requestIp}.` : '',
    "Didn't request a reset? You can safely ignore this email.",
    '',
    '— Sheer',
  ].filter(Boolean);

  return { subject, html, text: textLines.join('\n') };
}
