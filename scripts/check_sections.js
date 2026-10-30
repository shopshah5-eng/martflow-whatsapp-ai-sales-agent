import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

const html = fs.readFileSync(indexPath, 'utf8');

const tStart = html.indexOf('id="trialStatusBar"');
const tEnd = html.indexOf('id="view-dashboard"');
console.log('--- TRIAL STATUS BAR REGION ---');
console.log(html.slice(tStart, tEnd));

const catStart = html.indexOf('id="view-catalog"');
const catEnd = html.indexOf('</section>', catStart) + 10;
console.log('--- VIEW CATALOG REGION ---');
console.log(html.slice(catStart, catEnd));
