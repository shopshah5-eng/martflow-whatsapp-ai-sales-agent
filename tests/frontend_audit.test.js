import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('FRONTEND AUDIT: Inspects public/index.html for undefined handlers, alerts, and leaks', () => {
  const htmlPath = path.join(__dirname, '..', 'public', 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  // 1. Verify no alert() calls exist in public/index.html
  const alertMatches = [...html.matchAll(/\balert\s*\(/g)];
  assert.equal(alertMatches.length, 0, `Expected 0 alert() calls in public/index.html, found ${alertMatches.length}`);

  // 2. Verify no hardcoded phone number (+919115748457) is baked into UI
  assert.ok(!html.includes('9115748457'), 'Hardcoded phone number 9115748457 should not exist in public/index.html');

  // 3. Extract all inline event handlers (onclick, onchange, oninput, onsubmit)
  const handlerRegex = /\bon(click|change|input|submit)\s*=\s*"([^"]+)"/gi;
  const handlers = [];
  let match;
  while ((match = handlerRegex.exec(html)) !== null) {
    handlers.push(match[2]);
  }

  // Extract function identifiers called
  const domMethods = ['getElementById', 'querySelector', 'querySelectorAll', 'click', 'focus', 'blur', 'preventDefault', 'stopPropagation', 'reset'];
  const calledFns = new Set();
  handlers.forEach(h => {
    const fnRegex = /([a-zA-Z0-9_$]+)\s*\(/g;
    let fnMatch;
    while ((fnMatch = fnRegex.exec(h)) !== null) {
      const name = fnMatch[1];
      // Filter out language keywords and standard DOM methods
      if (!['if', 'for', 'while', 'switch', 'catch', 'typeof', 'alert', ...domMethods].includes(name)) {
        calledFns.add(name);
      }
    }
  });

  // Extract all script content
  const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let scriptContent = '';
  let scriptBlock;
  while ((scriptBlock = scriptRegex.exec(html)) !== null) {
    scriptContent += '\n' + scriptBlock[1];
  }

  // 4. Check that every function called in an inline handler is defined
  const missingFns = [];
  for (const fn of calledFns) {
    const isDefined =
      new RegExp(`function\\s+${fn}\\b`).test(scriptContent) ||
      new RegExp(`(?:window\\.)?${fn}\\s*=\\s*(?:async\\s*)?(?:function|\\()`).test(scriptContent) ||
      new RegExp(`(?:const|let|var)\\s+${fn}\\s*=`).test(scriptContent);
    if (!isDefined) {
      missingFns.push(fn);
    }
  }

  assert.deepEqual(missingFns, [], `Undefined functions called from HTML inline handlers: ${missingFns.join(', ')}`);

  // 5. Verify the required functions demanded by the user prompt exist
  const requiredFunctions = [
    'openSimulationModal',
    'debounceLeadsSearch',
    'switchView',
    'toggleChatMode',
    'sendManualReply',
    'checkWaConnection',
    'saveAiSettings',
    'loadAnalyticsData',
    'openQuickAddModal',
    'escapeHtml',
    'showToast'
  ];

  for (const reqFn of requiredFunctions) {
    const exists =
      new RegExp(`function\\s+${reqFn}\\b`).test(scriptContent) ||
      new RegExp(`${reqFn}\\s*=\\s*`).test(scriptContent);
    assert.ok(exists, `Required function ${reqFn} is missing in public/index.html script`);
  }

  // 6. Verify Configurable Backend URL (API_BASE) and Static Demo Engine exist
  assert.ok(scriptContent.includes('API_BASE'), 'API_BASE variable must be present');
  assert.ok(scriptContent.includes('handleStaticDemoRequest'), 'handleStaticDemoRequest preview fallback must be present');

  // 7. Verify Netlify _redirects file exists with proxy template
  const redirectsPath = path.join(__dirname, '..', 'public', '_redirects');
  assert.ok(fs.existsSync(redirectsPath), 'public/_redirects must exist');
  const redirectsContent = fs.readFileSync(redirectsPath, 'utf8');
  assert.ok(redirectsContent.includes('/api/*'), 'public/_redirects must contain /api/* proxy pattern');
  assert.ok(redirectsContent.includes('/*  /index.html  200'), 'public/_redirects must contain SPA fallback');

  // 8. Verify dynamic upgrade WhatsApp link
  assert.ok(html.includes('id="upgradeWaLink"'), 'Upgrade modal must have dynamic id="upgradeWaLink"');
  assert.ok(html.includes('id="upgradeDeskPhone"'), 'Upgrade modal must have dynamic id="upgradeDeskPhone"');
});
