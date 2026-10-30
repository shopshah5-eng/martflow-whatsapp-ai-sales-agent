import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

const html = fs.readFileSync(indexPath, 'utf8');
const asideStart = html.indexOf('<aside id="appSidebar"');
const asideEnd = html.indexOf('</aside>') + 8;
console.log(html.slice(asideStart, asideEnd));

