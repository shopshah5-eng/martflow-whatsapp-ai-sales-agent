import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';

test('homepage submits a consented synthetic enquiry to the isolated local API', async () => {
  process.env.NODE_ENV = 'test'; process.env.USE_LOCAL_DB = 'true';
  db.persist = () => {};
  const orgId = '6fd354d9-3437-412d-856e-28bc19d44268';
  db.tables.organizations = new Map([[orgId, { id: orgId, name: 'Synthetic demo tenant', plan_status: 'active' }]]);
  db.tables.leads = new Map(); db.tables.conversations = new Map(); db.tables.audit_logs = new Map();
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const vc = new VirtualConsole(); const errors = [];
  vc.on('jsdomError', error => { if (!error.message.includes('navigation to another Document')) errors.push(error.message); });
  const dom = new JSDOM(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), {
    url: `${origin}/?ref=PARTNER`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) { window.fetch = (url, options) => fetch(new URL(url, origin), options); }
  });
  try {
    const w = dom.window, d = w.document;
    await new Promise(resolve => setTimeout(resolve, 20));
    for (const [id, value] of Object.entries({ name: 'Synthetic Customer', business: 'Example Factory', email: 'synthetic@example.test', phone: '9876543210', message: 'Synthetic product enquiry' })) d.getElementById(id).value = value;
    d.getElementById('contactConsent').checked = true;
    d.querySelector('[data-interest="Standard Growth"]').click();
    await w.handleContactSubmit();
    assert.match(d.getElementById('formNote').textContent, /received/i);
    const leads = db.findScoped('leads', orgId);
    assert.equal(leads.length, 1);
    assert.equal(leads[0].buyer_name, 'Synthetic Customer');
    assert.equal(leads[0].buyer_phone, '919876543210');
    assert.equal(leads[0].product_inquired, 'Standard Growth');
    assert.match(leads[0].requirement, /Business: Example Factory/);
    assert.match(leads[0].requirement, /Email: synthetic@example.test/);
    assert.match(leads[0].requirement, /Partner reference: PARTNER/);
    assert.deepEqual(errors, []);
  } finally {
    dom.window.close(); await new Promise(resolve => server.close(resolve));
  }
});
