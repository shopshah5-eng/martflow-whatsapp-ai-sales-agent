import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const read = name => fs.readFileSync(new URL(`../public/${name}`, import.meta.url), 'utf8');

test('FRONTEND AUDIT: homepage uses the real existing asset, working routes and safe markup', () => {
  const html = read('index.html');
  const dom = new JSDOM(html);
  const d = dom.window.document;
  assert.equal(d.querySelector('.visual img').getAttribute('src'), '/assets/hero/hero-whatsapp.png');
  assert.ok(fs.existsSync(new URL('../public/assets/hero/hero-whatsapp.png', import.meta.url)));
  assert.ok(d.querySelector('a[href="/login"]'));
  assert.ok(d.querySelector('a[href="/signup"]'));
  assert.ok(d.querySelector('a[href="/demo"]'));
  assert.ok(d.querySelector('#contactForm'));
  assert.ok(d.querySelector('#contactConsent[required]'));
  assert.ok(html.includes('/api/public/demo-enquiry'));
  assert.equal(/\balert\s*\(/.test(html), false);
  assert.equal(html.includes('9115748457'), false);
  for (const a of d.querySelectorAll('a[href^="#"]')) {
    const id = a.getAttribute('href').slice(1);
    assert.ok(id && d.getElementById(id), `Missing anchor #${id}`);
  }
  assert.match(read('_redirects'), /\/demo\s+\/demo\.html/);
  assert.match(read('_redirects'), /\/api\/\*/);
  dom.window.close();
});

test('workspace retains the application handlers on the dedicated app page', () => {
  const html = read('app.html');
  for (const fn of ['openSimulationModal', 'debounceLeadsSearch', 'switchView', 'toggleChatMode', 'sendManualReply', 'checkWaConnection', 'saveAiSettings', 'loadAnalyticsData', 'openQuickAddModal', 'escapeHtml', 'showToast']) {
    assert.match(html, new RegExp(`function\\s+${fn}\\b`), `${fn} missing from workspace`);
  }
});
