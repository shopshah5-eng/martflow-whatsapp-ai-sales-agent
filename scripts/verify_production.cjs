const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '../public/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('=== PRODUCTION VERIFICATION GATE ===\n');

let failed = false;

// 1. Script compilation check
console.log('1. Checking inline script compilation...');
const lastScriptStart = html.lastIndexOf('<script>');
const lastScriptEnd = html.lastIndexOf('</script>');
const mainScriptCode = html.slice(lastScriptStart + '<script>'.length, lastScriptEnd);

// Check all inline scripts
const scriptRegex = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
let m;
let count = 0;
while ((m = scriptRegex.exec(html)) !== null) {
  if (m[0].includes('src=')) continue;
  count++;
  try {
    new vm.Script(m[1]);
    console.log(`   Script ${count} (${m[1].length} bytes): OK`);
  } catch (err) {
    console.error(`   Script ${count} FAILED:`, err.message);
    failed = true;
  }
}

// 2. Duplicate function declarations in main script
console.log('\n2. Checking for duplicate function definitions...');
const fnDefRegex = /(?:async\s+)?function\s+([a-zA-Z0-9_$]+)\s*\(/g;
const declaredFunctions = new Map();
while ((m = fnDefRegex.exec(mainScriptCode)) !== null) {
  const name = m[1];
  declaredFunctions.set(name, (declaredFunctions.get(name) || 0) + 1);
}
let dups = [];
for (const [name, c] of declaredFunctions.entries()) {
  if (c > 1) {
    dups.push(`${name} (${c}x)`);
  }
}
if (dups.length > 0) {
  console.error('   Found duplicate functions:', dups.join(', '));
  failed = true;
} else {
  console.log(`   OK: All ${declaredFunctions.size} functions declared exactly once!`);
}

// 3. Revenue loophole checks
console.log('\n3. Checking for revenue loopholes...');
const loopholeWords = ['100% Free', 'Lifetime Free', 'Zero Fees', '₹0 completely free', 'Active (Free)'];
let foundLoopholes = [];
for (const word of loopholeWords) {
  const regex = new RegExp(word.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&'), 'gi');
  if (regex.test(html)) {
    foundLoopholes.push(word);
  }
}
if (foundLoopholes.length > 0) {
  console.error('   Found revenue loophole words:', foundLoopholes.join(', '));
  failed = true;
} else {
  console.log('   OK: 0 revenue loopholes found in public/index.html!');
}

// 4. Missing DOM IDs check
console.log('\n4. Checking DOM IDs...');
const markupOnly = html.slice(0, lastScriptStart);

const idRegex = /document\.getElementById\(['"]([^'"]+)['"]\)/g;
const referencedIds = new Set();
while ((m = idRegex.exec(mainScriptCode)) !== null) {
  referencedIds.add(m[1]);
}
const htmlIdRegex = /\bid="([^"]+)"/g;
const presentIds = new Set();
while ((m = htmlIdRegex.exec(markupOnly)) !== null) {
  presentIds.add(m[1]);
}
const missingInHtml = [];
for (const id of referencedIds) {
  if (!presentIds.has(id)) {
    missingInHtml.push(id);
  }
}
if (missingInHtml.length > 0) {
  console.error(`   Missing IDs in HTML (${missingInHtml.length}):`, missingInHtml.join(', '));
  failed = true;
} else {
  console.log(`   OK: All ${referencedIds.size} referenced IDs exist in HTML!`);
}

// 5. Missing onclick handlers
console.log('\n5. Checking onclick handlers...');
const onclickRegex = /\bonclick="([^"]+)"/g;
const missingHandlers = [];
while ((m = onclickRegex.exec(markupOnly)) !== null) {
  const handler = m[1];
  const fnMatch = handler.match(/^([a-zA-Z0-9_$]+)\s*\(/);
  if (fnMatch) {
    const fnName = fnMatch[1];
    const checkRegex = new RegExp('(?:function\\s+' + fnName + '\\b|window\\.' + fnName + '\\s*=|const\\s+' + fnName + '\\s*=|let\\s+' + fnName + '\\s*=)');
    if (!checkRegex.test(mainScriptCode)) {
      missingHandlers.push(fnName);
    }
  }
}
if (missingHandlers.length > 0) {
  console.error('   Missing onclick functions:', missingHandlers.join(', '));
  failed = true;
} else {
  console.log('   OK: All onclick attributes link to valid JavaScript functions!');
}

console.log('\n======================================');
if (failed) {
  console.error('❌ VERIFICATION FAILED! Address the errors above.');
  process.exit(1);
} else {
  console.log('✅ ALL VERIFICATION GATES PASSED 100%!');
}
