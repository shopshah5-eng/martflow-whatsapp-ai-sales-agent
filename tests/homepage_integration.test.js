import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { JSDOM, VirtualConsole } from 'jsdom';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';

test('homepage uses the configured WhatsApp bot without creating a lead or sending a message', async () => {
  process.env.NODE_ENV = 'test'; process.env.USE_LOCAL_DB = 'true'; process.env.SUPPORT_WHATSAPP = '919876543210';
  db.persist = () => {};
  const orgId = '6fd354d9-3437-412d-856e-28bc19d44268';
  db.tables.organizations = new Map([[orgId, { id: orgId, name: 'Synthetic demo tenant', plan_status: 'active' }]]);
  db.tables.leads = new Map(); db.tables.conversations = new Map(); db.tables.audit_logs = new Map();
  const app = express(); app.use(express.json()); app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, requests = [];
  const vc = new VirtualConsole(), errors = [];
  vc.on('jsdomError', error => { if (!error.message.includes('navigation to another Document')) errors.push(error.message); });
  const dom = new JSDOM(fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'), {
    url: `${origin}/?ref=PARTNER`, runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc,
    beforeParse(window) { window.fetch = (url, options) => { requests.push({url, options}); return fetch(new URL(url, origin), options); }; }
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 100));
    const d=dom.window.document;
    d.querySelector('[data-interest="Standard Growth"]').click();
    const url = new URL(d.getElementById('contactWhatsApp').href);
    assert.equal(url.pathname, '/919876543210');
    assert.match(url.searchParams.get('text'), /Standard Growth/);
    assert.match(url.searchParams.get('text'), /Partner reference: PARTNER/);
    assert.equal(db.findScoped('leads', orgId).length, 0);
    assert.equal(requests.some(r => r.options?.method === 'POST'), false);
    assert.deepEqual(errors, []);
  } finally { dom.window.close(); await new Promise(resolve => server.close(resolve)); }
});
