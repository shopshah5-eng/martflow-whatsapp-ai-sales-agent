import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

let html = fs.readFileSync(indexPath, 'utf8');

// Match catalogDropzone with flexible whitespace
const regexExtraDiv = /(<div id="catalogUploadStatus"[^>]*><\/div>\s*<\/div>\s*<\/div>)\s*<\/div>/;
if (regexExtraDiv.test(html)) {
  html = html.replace(regexExtraDiv, '$1');
  console.log('✓ Successfully removed extra </div> after catalogDropzone!');
}

fs.writeFileSync(indexPath, html, 'utf8');

const tags = ['div', 'section', 'aside', 'main', 'header'];
console.log('--- GLOBAL TAG BALANCE ---');
tags.forEach(t => {
  const openCount = (html.match(new RegExp('<' + t + '[ >]', 'gi')) || []).length;
  const closeCount = (html.match(new RegExp('</' + t + '>', 'gi')) || []).length;
  console.log(`${t}: open=${openCount}, close=${closeCount}, diff=${openCount - closeCount}`);
});
