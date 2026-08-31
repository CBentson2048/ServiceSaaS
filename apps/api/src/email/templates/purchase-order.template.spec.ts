/**
 * The supplier-facing order email. These assertions guard the two things a
 * supplier acts on: WHERE the order goes (location name plus its address in
 * brackets) and WHAT is ordered, in both the HTML and plain-text parts.
 */
import { renderPurchaseOrderEmail, type PurchaseOrderEmailInput } from './purchase-order.template';

const BASE: PurchaseOrderEmailInput = {
  supplierName: 'Wella Professionals',
  businessName: 'Luke Ormsby Hair',
  locationName: 'Primrose Hill',
  locationAddress: "12 Regent's Park Road, London, NW1 8XL",
  accountReference: 'LOH-123',
  orderNumber: 'PO-00005',
  lines: [{ productName: 'Majirel 6.0 Dark Blonde', packSize: 50, stockUnit: 'gram', quantity: 2 }],
  contactEmail: 'owner@salon.test',
};

describe('renderPurchaseOrderEmail', () => {
  it('prints the location address in brackets after the location name', () => {
    const { html, text } = renderPurchaseOrderEmail(BASE);
    const label = "Primrose Hill (12 Regent&#39;s Park Road, London, NW1 8XL)";
    expect(html).toContain(`From Luke Ormsby Hair, ${label}`);
    expect(text).toContain("From Luke Ormsby Hair, Primrose Hill (12 Regent's Park Road, London, NW1 8XL)");
    // The closing line names the branch only; the address is not worth repeating.
    expect(html).toContain('deliver to Primrose Hill.');
    expect(text).toContain('deliver to Primrose Hill.');
  });

  it('falls back to the bare location name when no address is on record', () => {
    const { html, text } = renderPurchaseOrderEmail({ ...BASE, locationAddress: undefined });
    expect(html).toContain('From Luke Ormsby Hair, Primrose Hill<');
    expect(html).not.toContain('Primrose Hill (');
    expect(text).toContain('From Luke Ormsby Hair, Primrose Hill\n');
  });

  it('treats a blank address as no address', () => {
    const { text } = renderPurchaseOrderEmail({ ...BASE, locationAddress: '   ' });
    expect(text).toContain('From Luke Ormsby Hair, Primrose Hill\n');
  });

  it('uses no em dash anywhere a supplier can read', () => {
    const rendered = renderPurchaseOrderEmail({ ...BASE, notes: 'Deliver before 10am please' });
    expect(rendered.subject).not.toContain('—');
    expect(rendered.html).not.toContain('—');
    expect(rendered.text).not.toContain('—');
  });

  it('names the order number in the subject and the quoting line', () => {
    const { subject, html, text } = renderPurchaseOrderEmail(BASE);
    expect(subject).toBe('Purchase order PO-00005 from Luke Ormsby Hair');
    expect(html).toContain('Please quote <strong>PO-00005</strong>');
    expect(text).toContain('Please quote PO-00005 on the delivery note and invoice');
  });

  it('keeps blank lines between paragraphs in the plain-text part', () => {
    const { text } = renderPurchaseOrderEmail(BASE);
    expect(text).toContain('Account ref LOH-123\n\nHello Wella Professionals,\n');
    expect(text).toMatch(/\n\nThank you,\nLuke Ormsby Hair$/);
  });

  it('drops the account ref and the reply invitation when neither is known', () => {
    const { html, text } = renderPurchaseOrderEmail({
      ...BASE,
      accountReference: undefined,
      contactEmail: undefined,
    });
    expect(html).not.toContain('Account ref');
    expect(text).not.toContain('Account ref');
    expect(text).not.toContain('reply to this email');
  });

  it('states each line as packs of its base quantity', () => {
    const { html, text } = renderPurchaseOrderEmail({
      ...BASE,
      lines: [
        { productName: 'Majirel 6.0', packSize: 50, stockUnit: 'gram', quantity: 2 },
        { productName: 'Developer 6%', packSize: 1000, stockUnit: 'millilitre', quantity: 1 },
        { productName: 'Tint brush', stockUnit: 'unit', quantity: 3 },
      ],
    });
    expect(html).toContain('2 × 50g');
    expect(html).toContain('1 × 1000ml');
    expect(html).toContain('3 units');
    expect(text).toContain('  - Majirel 6.0: 2 × 50g');
    expect(text).toContain('  - Tint brush: 3 units');
  });

  it('escapes supplier-supplied text in the HTML part', () => {
    const { html } = renderPurchaseOrderEmail({
      ...BASE,
      lines: [{ productName: '<script>alert(1)</script>', stockUnit: 'unit', quantity: 1 }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
