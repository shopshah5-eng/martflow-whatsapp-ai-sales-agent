import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

let html = fs.readFileSync(indexPath, 'utf8');

// Replace duplicate catch in fetchCatalogProducts
const duplicateCatch = `      } catch (err) {
        if (tbody) tbody.innerHTML = \`<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading catalog: \${escapeHtml(err.message)}</td></tr>\`;
      }
    } catch (err) {
        tbody.innerHTML = \`<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading catalog: \${escapeHtml(err.message)}</td></tr>\`;
      }
    }`;

const cleanCatch = `      } catch (err) {
        if (tbody) tbody.innerHTML = \`<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading catalog: \${escapeHtml(err.message)}</td></tr>\`;
      }
    }`;

if (html.includes(duplicateCatch)) {
  html = html.replace(duplicateCatch, cleanCatch);
  console.log('✓ Removed duplicate catch block cleanly!');
} else {
  // Regex
  const regexCatch = /\}\s*catch\s*\(err\)\s*\{\s*tbody\.innerHTML\s*=\s*`<tr><td colspan="7"[^`]*`[^}]*\}\s*\}/;
  if (regexCatch.test(html)) {
    html = html.replace(regexCatch, '');
    console.log('✓ Removed duplicate catch block via regex!');
  }
}

fs.writeFileSync(indexPath, html, 'utf8');

// Test compilation of all scripts
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let scriptIdx = 0;
let allOk = true;

while ((match = scriptRegex.exec(html)) !== null) {
  scriptIdx++;
  const code = match[1];
  if (!code.trim()) continue;
  try {
    new vm.Script(code, { filename: `script_${scriptIdx}.js` });
    console.log(`Script ${scriptIdx}: 100% VALID JAVASCRIPT ✓ (${code.length} chars)`);
  } catch (err) {
    console.error(`Script ${scriptIdx} SYNTAX ERROR:`, err.message);
    allOk = false;
    // Dump script for inspection
    fs.writeFileSync(path.join(__dirname, `script_err_${scriptIdx}.js`), code, 'utf8');
  }
}

if (allOk) {
  console.log('🎉 ALL SCRIPTS IN public/index.html COMPILE WITH ZERO SYNTAX ERRORS!');
}
