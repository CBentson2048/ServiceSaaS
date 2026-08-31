/**
 * Week 6 ticket 9: the order form a supplier receives.
 *
 * Quantities are in PACKS (the unit a supplier sells in), each line naming the
 * pack it means ("6 × 100g"). Internal cost estimates are deliberately NOT
 * included; they are the salon's own bookkeeping, not an offer to the
 * supplier. Letterhead/wording is the plan §17 open question with Luke; this
 * template keeps to the facts a supplier needs to fulfil the order.
 */

export interface PurchaseOrderEmailLine {
  productName: string;
  /** Base quantities per pack; undefined for unit items with no recorded pack. */
  packSize?: number;
  stockUnit: 'gram' | 'millilitre' | 'unit';
  /** Packs ordered. */
  quantity: number;
}

export interface PurchaseOrderEmailInput {
  supplierName: string;
  businessName: string;
  locationName: string;
  /**
   * One-line postal address of that location, shown in brackets after the
   * name so the supplier can see where the order is going without looking the
   * branch up. Undefined when no address is on record.
   */
  locationAddress?: string;
  /** The salon's account number with this supplier, when recorded. */
  accountReference?: string;
  orderNumber: string;
  lines: PurchaseOrderEmailLine[];
  notes?: string;
  /** Reply-to shown to the supplier: the owner/manager placing the order. */
  contactEmail?: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

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

function packLabel(line: PurchaseOrderEmailLine): string {
  if (line.stockUnit === 'unit') return line.quantity === 1 ? 'unit' : 'units';
  if (!line.packSize) return line.quantity === 1 ? 'pack' : 'packs';
  const unit = line.stockUnit === 'millilitre' ? 'ml' : 'g';
  return `× ${line.packSize}${unit}`;
}

/** "Primrose Hill (12 Regent's Park Road, London, NW1 8XL)", or just the name. */
function locationLabel(input: PurchaseOrderEmailInput): string {
  const address = input.locationAddress?.trim();
  return address ? `${input.locationName} (${address})` : input.locationName;
}

export function renderPurchaseOrderEmail(input: PurchaseOrderEmailInput): RenderedEmail {
  const subject = `Purchase order ${input.orderNumber} from ${input.businessName}`;

  const rowsHtml = input.lines
    .map(
      (line) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};">${escapeHtml(line.productName)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid ${BORDER};text-align:right;white-space:nowrap;">
            ${line.quantity} ${escapeHtml(packLabel(line))}
          </td>
        </tr>`,
    )
    .join('');

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:${BRAND_DARK};max-width:560px;margin:0 auto;">
    <h2 style="margin:24px 0 4px;">Purchase order ${escapeHtml(input.orderNumber)}</h2>
    <p style="margin:0 0 16px;color:${MUTED};">
      From ${escapeHtml(input.businessName)}, ${escapeHtml(locationLabel(input))}${
        input.accountReference ? `<br/>Account ref ${escapeHtml(input.accountReference)}` : ''
      }
    </p>
    <p style="margin:0 0 16px;">Hello ${escapeHtml(input.supplierName)},</p>
    <p style="margin:0 0 16px;">Please supply the following order:</p>
    <table style="border-collapse:collapse;width:100%;border:1px solid ${BORDER};">
      <thead>
        <tr style="background:#F9FAFB;">
          <th style="padding:8px 12px;text-align:left;border-bottom:1px solid ${BORDER};">Product</th>
          <th style="padding:8px 12px;text-align:right;border-bottom:1px solid ${BORDER};">Quantity</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}
      </tbody>
    </table>
    ${input.notes ? `<p style="margin:16px 0 0;color:${MUTED};">Notes: ${escapeHtml(input.notes)}</p>` : ''}
    <p style="margin:24px 0 0;">
      Please quote <strong>${escapeHtml(input.orderNumber)}</strong> on the delivery note and invoice,
      and deliver to ${escapeHtml(input.locationName)}.
      ${input.contactEmail ? `Any questions, just reply to this email.` : ''}
    </p>
    <p style="margin:16px 0 24px;color:${MUTED};">Thank you,<br/>${escapeHtml(input.businessName)}</p>
  </div>`;

  const textLines = input.lines
    .map((line) => `  - ${line.productName}: ${line.quantity} ${packLabel(line)}`)
    .join('\n');
  // `null` marks a line that is absent for this order; a bare '' is a real
  // blank line between paragraphs, so only the nulls are filtered out.
  const text = [
    `Purchase order ${input.orderNumber}`,
    `From ${input.businessName}, ${locationLabel(input)}`,
    input.accountReference ? `Account ref ${input.accountReference}` : null,
    '',
    `Hello ${input.supplierName},`,
    '',
    'Please supply the following order:',
    textLines,
    input.notes ? `\nNotes: ${input.notes}` : null,
    '',
    `Please quote ${input.orderNumber} on the delivery note and invoice, and deliver to ${input.locationName}.`,
    input.contactEmail ? 'Any questions, just reply to this email.' : null,
    '',
    'Thank you,',
    input.businessName,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  return { subject, html, text };
}
