/**
 * Visual harness for the Product Management redesign. Renders the real page
 * with canned API responses so layout can be inspected at real viewport sizes
 * without a backend. Development tool only — never part of the app bundle.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { InventoryManagementPage } from '../src/pages/InventoryManagementPage';
import { InventoryPage } from '../src/pages/InventoryPage';
import '../src/styles/index.css';

const now = Date.now();
const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();

const products = [
  { id: 'p1', businessId: 'b1', name: 'Majirel 6.0 Dark Blonde', brand: 'L’Oréal', sku: 'MAJ-60', categoryId: 'c1', category: 'Permanent colour', sizeValue: 100, sizeUnit: 'g', defaultUnit: 'g', defaultCostPerGramCents: 5, retailPriceCents: 1499, lowStockThresholdGrams: 150, isActive: true, stockUnit: 'gram', packSize: 100, barcode: '5010000000001', supplierId: 's1', supplierName: 'Wella Professionals', minimumOrderQuantity: 6, orderMultiple: 6, deadStockDays: 90, isSalonUse: true, isLabUse: true, isRetail: false, createdAt: iso(50000), updatedAt: iso(500) },
  { id: 'p2', businessId: 'b1', name: 'Blondor Freelights', brand: 'Wella', sku: 'BL-FL', categoryId: 'c2', category: 'Lightener', sizeValue: 400, sizeUnit: 'g', defaultUnit: 'g', defaultCostPerGramCents: 4, lowStockThresholdGrams: 200, isActive: true, stockUnit: 'gram', packSize: 400, barcode: '5010000000002', minimumOrderQuantity: 1, orderMultiple: 1, isSalonUse: true, isLabUse: true, isRetail: false, createdAt: iso(50000), updatedAt: iso(900) },
  { id: 'p3', businessId: 'b1', name: 'Finishing Spray', brand: 'Salon Own', sku: 'FIN-SP', categoryId: 'c3', category: 'Styling', defaultUnit: 'unit', defaultCostPerGramCents: 850, retailPriceCents: 1800, lowStockThresholdGrams: 4, isActive: true, stockUnit: 'unit', minimumOrderQuantity: 1, orderMultiple: 1, isSalonUse: true, isLabUse: false, isRetail: true, createdAt: iso(50000), updatedAt: iso(4000) },
  { id: 'p4', businessId: 'b1', name: 'Bond Repair Treatment', brand: 'Olaplex', sku: 'BND-1', categoryId: 'c4', category: 'Treatment', sizeValue: 100, sizeUnit: 'ml', defaultUnit: 'ml', defaultCostPerGramCents: 9, lowStockThresholdGrams: 50, isActive: true, stockUnit: 'millilitre', packSize: 100, minimumOrderQuantity: 1, orderMultiple: 1, isSalonUse: true, isLabUse: true, isRetail: true, createdAt: iso(50000), updatedAt: iso(9000) },
  { id: 'p5', businessId: 'b1', name: 'Colour Remover', brand: 'Salon Own', sku: 'CR-01', categoryId: 'c1', category: 'Permanent colour', sizeValue: 200, sizeUnit: 'g', defaultUnit: 'g', defaultCostPerGramCents: 3, lowStockThresholdGrams: 0, isActive: true, stockUnit: 'gram', packSize: 200, minimumOrderQuantity: 1, orderMultiple: 1, isSalonUse: true, isLabUse: false, isRetail: false, createdAt: iso(50000), updatedAt: iso(20000) },
];

const stock = [
  { id: 'st1', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p1', productName: 'Majirel 6.0 Dark Blonde', brand: 'L’Oréal', sku: 'MAJ-60', category: 'Permanent colour', quantityOnHandGrams: 640, effectiveLowStockThresholdGrams: 150, isLowStock: false, isActive: true, updatedAt: iso(60) },
  { id: 'st2', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p2', productName: 'Blondor Freelights', brand: 'Wella', sku: 'BL-FL', category: 'Lightener', quantityOnHandGrams: 120, effectiveLowStockThresholdGrams: 200, isLowStock: true, isActive: true, updatedAt: iso(200) },
  { id: 'st3', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p3', productName: 'Finishing Spray', brand: 'Salon Own', sku: 'FIN-SP', category: 'Styling', quantityOnHandGrams: 0, effectiveLowStockThresholdGrams: 4, isLowStock: true, isActive: true, updatedAt: iso(1500) },
  { id: 'st4', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p4', productName: 'Bond Repair Treatment', brand: 'Olaplex', sku: 'BND-1', category: 'Treatment', quantityOnHandGrams: 900, effectiveLowStockThresholdGrams: 50, isLowStock: false, isActive: true, updatedAt: iso(8000) },
];

const movements = [
  { id: 'mv1', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p1', productName: 'Majirel 6.0 Dark Blonde', brand: 'L’Oréal', movementType: 'restock', quantityDeltaGrams: 200, reason: 'Delivery 8841', createdBy: 'bf09e3e5-0a3f-4a1c-9a1b-2f7c1a5e8d90', createdByName: 'Ada Lovelace', createdAt: iso(58) },
  { id: 'mv2', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p2', productName: 'Blondor Freelights', brand: 'Wella', movementType: 'salon_consumption', quantityDeltaGrams: -30, referenceType: 'barcode_scan', createdBy: 'aa', createdByName: 'Marcus Chen', createdAt: iso(125) },
  { id: 'mv3', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p1', productName: 'Majirel 6.0 Dark Blonde', movementType: 'formula_usage', quantityDeltaGrams: -45, createdAt: iso(240) },
  { id: 'mv4', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p3', productName: 'Finishing Spray', movementType: 'retail_sale', quantityDeltaGrams: -1, createdAt: iso(1500) },
  { id: 'mv5', businessId: 'b1', locationId: 'loc-1', locationName: 'Pinner', productId: 'p5', productName: 'Colour Remover', movementType: 'manual_adjustment', quantityDeltaGrams: -20, reason: 'Breakage', createdByName: 'Luke Ormsby', createdAt: iso(4000) },
];

const deadStock = [
  { locationId: 'loc-1', locationName: 'Pinner', productId: 'p5', productName: 'Colour Remover', brand: 'Salon Own', sku: 'CR-01', quantityOnHandGrams: 400, stockUnit: 'gram', lastOutboundAt: iso(60 * 24 * 120), idleSince: iso(60 * 24 * 120), daysIdle: 120, thresholdDays: 90, thresholdSource: 'location_default', estimatedValueCents: 1200 },
  { locationId: 'loc-1', locationName: 'Pinner', productId: 'p4', productName: 'Bond Repair Treatment', brand: 'Olaplex', sku: 'BND-1', supplierName: 'Olaplex UK', quantityOnHandGrams: 900, stockUnit: 'millilitre', idleSince: iso(60 * 24 * 60), daysIdle: 60, thresholdDays: 30, thresholdSource: 'product', estimatedValueCents: 8100 },
];

const routes: [RegExp, unknown][] = [
  [/\/api\/inventory\/products\?/, { products }],
  [/\/api\/inventory\/products$/, { products }],
  [/\/api\/inventory\/categories/, { categories: [
    { id: 'c1', businessId: 'b1', name: 'Permanent colour', isActive: true, createdAt: '', updatedAt: '' },
    { id: 'c2', businessId: 'b1', name: 'Lightener', isActive: true, createdAt: '', updatedAt: '' },
    { id: 'c3', businessId: 'b1', name: 'Styling', isActive: true, createdAt: '', updatedAt: '' },
    { id: 'c4', businessId: 'b1', name: 'Treatment', isActive: true, createdAt: '', updatedAt: '' },
  ] }],
  [/\/api\/inventory\/suppliers/, { suppliers: [{ id: 's1', businessId: 'b1', name: 'Wella Professionals', contactEmail: 'orders@wella.test', isActive: true, createdAt: '', updatedAt: '' }] }],
  [/\/api\/inventory\/stock/, { stock, locations: [{ id: 'loc-1', name: 'Pinner' }, { id: 'loc-2', name: 'Kensington' }], scope: 'owner' }],
  [/\/api\/inventory\/movements/, { movements }],
  [/\/api\/inventory\/dead-stock/, { items: deadStock, locations: [], totalEstimatedValueCents: 9300 }],
  [/\/api\/inventory\/products\/.*\/availability/, { productId: 'p1', locations: [{ locationId: 'loc-1', locationName: 'Pinner', available: true }, { locationId: 'loc-2', locationName: 'Kensington', available: false }] }],
  [/\/api\/retail-pricing\/effective/, { pricing: { productId: 'p1', locationId: 'loc-1', unitCostCents: 500, sellingPriceCents: 1499, pricingMode: 'fixed_price', configuredValue: 1499, effectiveMarkupPercent: 199.8, source: 'product_default', sourceRuleId: 'r1', sourceLabel: 'Product default', currencyCode: 'GBP' } }],
];

window.fetch = (async (input: RequestInfo | URL) => {
  const url = typeof input === 'string' ? input : input.toString();
  // Availability is matched before the generic products route.
  const match = url.includes('/availability')
    ? routes.find(([pattern]) => pattern.source.includes('availability'))
    : routes.find(([pattern]) => pattern.test(url));
  return new Response(JSON.stringify(match ? match[1] : {}), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/inventory']}>
      <div className="min-h-screen bg-bg text-text-primary">
        <Routes>
          <Route path="/inventory" element={<InventoryManagementPage />}>
            <Route index element={<InventoryPage />} />
          </Route>
        </Routes>
      </div>
    </MemoryRouter>
  </StrictMode>,
);
