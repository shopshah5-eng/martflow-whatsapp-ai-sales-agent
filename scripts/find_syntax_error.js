import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

const html = fs.readFileSync(indexPath, 'utf8');

const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let match;
let scriptIdx = 0;
while ((match = scriptRegex.exec(html)) !== null) {
  scriptIdx++;
  if (scriptIdx === 8) {
    const code = match[1];
    fs.writeFileSync(path.join(__dirname, 'temp_script.js'), code, 'utf8');
    try {
      new vm.Script(code, { filename: 'public/index.html' });
      console.log('Script 8 compiles perfectly with vm.Script!');
    } catch (err) {
      console.error('VM Compilation Error:', err);
    }
  }
}
