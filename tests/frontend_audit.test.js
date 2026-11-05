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
  assert.equal(d.querySelector('#contactForm'), null);
  assert.match(d.querySelector('#contactWhatsApp').href, /^https:\/\/wa\.me\/\d+/);
  assert.equal(d.querySelector('#contactWhatsApp').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(html.includes('/api/public/demo-enquiry'), false);
  assert.equal(/\balert\s*\(/.test(html), false);
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
  assert.equal(html.includes('Send Live Test WhatsApp Now'), false);
  assert.equal(html.includes('sendLiveTestWhatsApp'), false);
  for (const fn of ['openSimulationModal', 'debounceLeadsSearch', 'switchView', 'toggleChatMode', 'sendManualReply', 'checkWaConnection', 'saveAiSettings', 'loadAnalyticsData', 'openQuickAddModal', 'escapeHtml', 'showToast']) {
    assert.match(html, new RegExp(`function\\s+${fn}\\b`), `${fn} missing from workspace`);
  }
});
