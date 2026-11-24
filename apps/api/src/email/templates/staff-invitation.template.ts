import type { InvitableRole } from '@sheer/domain';

export interface StaffInvitationEmailInput {
  /** Invitee first name. Used in the greeting; falls back to "there". */
  recipientFirstName?: string;
  /** Display name of the inviter (the owner). Used in the body and reply-to. */
  inviterName?: string;
  /** Reply-to email — typically the inviter or business support address. */
  inviterEmail?: string;
  /** Business / salon name. */
  businessName?: string;
  /** Location name the invitee is being assigned to. */
  locationName?: string;
  /** Invited role. */
  role: InvitableRole;
  /** Fully-qualified URL to the accept-invite page. */
  inviteUrl: string;
  /** ISO timestamp the invitation expires at. */
  expiresAt: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

const BRAND_COLOR = '#6B3A57';
const BRAND_DARK = '#2B1927';
const MUTED = '#6D6066';
const BORDER = '#E4D9CF';

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

function roleLabel(role: InvitableRole): string {
  return role === 'manager' ? 'Manager' : 'Stylist';
}

export function renderStaffInvitationEmail(input: StaffInvitationEmailInput): RenderedEmail {
  const greeting = input.recipientFirstName?.trim() || 'there';
  const business = input.businessName?.trim() || 'your team';
  const location = input.locationName?.trim();
  const inviter = input.inviterName?.trim();
  const role = roleLabel(input.role);
  const expires = formatExpiry(input.expiresAt);

  const subject = `You're invited to join ${business} on QLOOQO`;

  const introLine = inviter
    ? `${escapeHtml(inviter)} has invited you to join <strong>${escapeHtml(business)}</strong> as a <strong>${escapeHtml(role)}</strong>${location ? ` at <strong>${escapeHtml(location)}</strong>` : ''}.`
    : `You've been invited to join <strong>${escapeHtml(business)}</strong> as a <strong>${escapeHtml(role)}</strong>${location ? ` at <strong>${escapeHtml(location)}</strong>` : ''}.`;

  const introTextLine = inviter
    ? `${inviter} has invited you to join ${business} as a ${role}${location ? ` at ${location}` : ''}.`
    : `You've been invited to join ${business} as a ${role}${location ? ` at ${location}` : ''}.`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#F5F0EA;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:${BRAND_DARK};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(introTextLine)} Accept your invitation before ${escapeHtml(expires)}.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F0EA;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background-color:#FFFFFF;border:1px solid ${BORDER};border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0 32px;">
                <div style="font-size:18px;font-weight:600;color:${BRAND_COLOR};letter-spacing:0.4px;">QLOOQO</div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 8px 32px;">
                <h1 style="margin:0;font-size:22px;line-height:30px;font-weight:600;color:${BRAND_DARK};">
                  Hi ${escapeHtml(greeting)}, you're invited.
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0 32px;">
                <p style="margin:0;font-size:14px;line-height:22px;color:${BRAND_DARK};">
                  ${introLine}
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td align="center" style="padding:8px 0 4px 0;">
                      <a href="${escapeHtml(input.inviteUrl)}" target="_blank" rel="noopener noreferrer"
                         style="display:inline-block;background-color:${BRAND_COLOR};color:#FFFFFF;text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:12px 24px;border-radius:9999px;">
                        Accept invitation
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
                  <a href="${escapeHtml(input.inviteUrl)}" style="color:${BRAND_COLOR};word-break:break-all;">${escapeHtml(input.inviteUrl)}</a>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <div style="border-top:1px solid ${BORDER};"></div>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 28px 32px;">
                <p style="margin:0;font-size:12px;line-height:18px;color:${MUTED};">
                  This invitation expires on <strong>${escapeHtml(expires)}</strong>. If you weren't expecting it, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
          <div style="max-width:560px;width:100%;margin:16px auto 0 auto;font-size:11px;line-height:16px;color:${MUTED};text-align:center;">
            Sent by QLOOQO on behalf of ${escapeHtml(business)}.
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    `Hi ${greeting},`,
    '',
    introTextLine,
    '',
    'Accept your invitation:',
    input.inviteUrl,
    '',
    `This invitation expires on ${expires}.`,
    "If you weren't expecting it, you can safely ignore this email.",
    '',
    `QLOOQO, on behalf of ${business}`,
  ];

  return { subject, html, text: textLines.join('\n') };
}
