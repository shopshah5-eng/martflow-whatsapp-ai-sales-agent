import test from 'node:test';
import assert from 'node:assert/strict';
import { signUp } from '../src/auth/authService.js';
import { CatalogService } from '../src/services/catalogService.js';

test('CATALOG PROCESSING: Ingests CSV spreadsheet into structured product records', async () => {
  const org = await signUp({
    email: `catalog_test_${Date.now()}@industry.in`,
    password: 'Password123!',
    fullName: 'Anil Gupta',
    companyName: 'Gupta Filling Lines'
  });

  const csvContent = `Product Name,Model,Capacity,Price,Application
"4-Head Liquid Filling Machine",FL-400,60 bottles/min,"₹2,45,000 + GST",Syrup and Oil
"Rotary Bottle Labeler",RBL-120,120 bottles/min,"₹1,85,000 + GST",Round Glass and PET Bottles`;

  const buffer = Buffer.from(csvContent, 'utf8');
  const result = await CatalogService.ingestCatalog(org.organization.id, {
    filename: 'Liquid_Packaging_Equipment.csv',
    buffer
  });

  assert.equal(result.productsCount, 2);
  assert.equal(result.products.length, 2);

  const p1 = result.products.find((p) => p.name.includes('Liquid Filling Machine'));
  assert.ok(p1, 'Must find Liquid Filling Machine');
  assert.equal(p1.price_raw, '₹2,45,000 + GST');
  assert.equal(p1.organization_id, org.organization.id);

  // List products
  const list = CatalogService.listProducts(org.organization.id);
  assert.equal(list.length, 2);
});
