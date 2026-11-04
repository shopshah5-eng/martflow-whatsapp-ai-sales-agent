import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const load = name => fs.readFileSync(new URL(`../public/${name}.html`, import.meta.url), 'utf8');

test('customer-facing pages display the Leadsy brand without changing existing routes', () => {
  for (const page of ['index', 'login', 'app', 'admin']) {
    const dom = new JSDOM(load(page));
    const { document } = dom.window;
    assert.match(document.title, /Leadsy/);
    assert.match(document.body.textContent, /Leadsy/);
    assert.equal(document.querySelectorAll('[id="links"] a[href="/login"]').length > 0 || page !== 'index', true);
    if (page === 'index') {
      assert.doesNotMatch(document.querySelector('main').textContent, /MartFlow/i);
      assert.match(document.querySelector('img[src="/assets/hero/hero-whatsapp.png"]').alt, /Leadsy/);
      assert.doesNotMatch(document.querySelector('main').textContent, /smart follow-ups/i);
    }
    if (page === 'login' || page === 'app' || page === 'admin') {
      assert.ok(document.querySelector('link[href="/css/martflow-design-system.css"]'));
    }
    dom.window.close();
  }
  assert.ok(fs.statSync(new URL('../public/assets/hero/hero-whatsapp.png', import.meta.url)).size > 0);
});
