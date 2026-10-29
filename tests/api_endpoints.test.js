import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';
import { demoLogin } from '../src/auth/authService.js';

test('API ROUTES: Authenticated multi-tenant endpoints behave correctly', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}`;

  try {
    // 1. Demo Login
    const demo = await demoLogin();
    assert.ok(demo.token, 'Should return session token');
    assert.ok(demo.organization.id, 'Should return organization id');

    const headers = {
      'Authorization': `Bearer ${demo.token}`,
      'Content-Type': 'application/json'
    };

    // 2. WhatsApp Status
    const waRes = await fetch(`${baseUrl}/api/whatsapp/status`, { headers });
    assert.equal(waRes.status, 200);
    const waData = await waRes.json();
    assert.equal(waData.ok, true);
    assert.ok(waData.status !== undefined);

    // 3. Lead Simulation
    const simRes = await fetch(`${baseUrl}/api/leads/simulate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        buyerName: 'Amit Bansal',
        buyerPhone: '9811981100',
        productQuery: 'Carton Sealer Box Taping Machine',
        city: 'Noida',
        message: 'Looking for automatic flap closing carton sealer.'
      })
    });
    assert.equal(simRes.status, 200);
    const simData = await simRes.json();
    assert.equal(simData.ok, true);
    assert.equal(simData.status, 'accepted');
    assert.ok(simData.leadId);

    // 4. Conversations List
    const convRes = await fetch(`${baseUrl}/api/conversations`, { headers });
    assert.equal(convRes.status, 200);
    const convData = await convRes.json();
    assert.equal(convData.ok, true);
    assert.ok(Array.isArray(convData.conversations));

    // 5. Quick Add SKU
    const skuRes = await fetch(`${baseUrl}/api/catalog/quick-add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Continuous Band Sealer with Nitrogen Flushing',
        category: 'Packaging Machinery',
        price: '₹48,000 + GST',
        moq: '1 Unit',
        specs: { 'Speed': '0-12m/min', 'Power': '500W' }
      })
    });
    assert.equal(skuRes.status, 200);
    const skuData = await skuRes.json();
    assert.equal(skuData.ok, true);
    assert.equal(skuData.product.name, 'Continuous Band Sealer with Nitrogen Flushing');

    // 6. Authenticated CSV Export
    const csvRes = await fetch(`${baseUrl}/api/leads/export.csv`, {
      headers: { 'Authorization': `Bearer ${demo.token}` }
    });
    assert.equal(csvRes.status, 200);
    const csvText = await csvRes.text();
    assert.ok(csvText.includes('Lead ID,Created At (IST),Buyer Name,Phone Number'));
    assert.ok(csvText.includes('Amit Bansal'));

    // 7. Tenant Webhook by Key
    const webhookRes = await fetch(`${baseUrl}/api/webhook/indiamart/${demo.organization.webhook_key || demo.organization.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        SENDER_NAME: 'Sunil Verma',
        SENDER_MOBILE: '9876543210',
        QUERY_PRODUCT_NAME: 'Continuous Band Sealer',
        SENDER_CITY: 'Surat',
        QUERY_MESSAGE: 'Please send latest price list'
      })
    });
    assert.equal(webhookRes.status, 200);
    const webhookData = await webhookRes.json();
    assert.equal(webhookData.status, 'accepted');

  } finally {
    server.close();
  }
});
