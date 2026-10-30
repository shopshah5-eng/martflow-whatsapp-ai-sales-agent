import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

let html = fs.readFileSync(indexPath, 'utf8');

// 1. ADD SheetJS & PDF.js to <head>
if (!html.includes('xlsx.full.min.js')) {
  const target = '<script src="https://checkout.razorpay.com/v1/checkout.js"></script>';
  const replacement = `<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
  <script>
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  </script>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>`;
  html = html.replace(target, replacement);
  console.log('✓ Added SheetJS and PDF.js to <head>');
}

// 2. RESTORE 48-HOUR LIVE TRIAL BANNER (REMOVE "100% Free Lifetime Access")
const trialBarRegex = /<!-- TOP TRIAL STATUS BAR[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/;
const newTrialBar = `<!-- TOP TRIAL STATUS BAR (48-HOUR LIVE TRIAL BANNER) -->
      <div id="trialStatusBar" class="mb-5 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 border border-indigo-500/30 rounded-xl p-3.5 text-white shadow-sm flex flex-col sm:flex-row items-center justify-between gap-3">
        <div class="flex items-center space-x-3 text-xs w-full sm:w-auto">
          <span class="flex h-2.5 w-2.5 relative shrink-0">
            <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span class="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
          </span>
          <div>
            <div class="font-bold text-emerald-300 flex items-center gap-1.5 flex-wrap">
              <span>🎁 48-Hour Live Trial Active</span>
              <span id="trialLeadsBadge" class="text-slate-300 font-normal text-[11px]">(25 Free Inquiries Included)</span>
            </div>
            <div id="trialCountdownText" class="text-[11px] text-emerald-200/90 font-mono mt-0.5 font-medium">
              47h 59m trial remaining • 25 inquiries included
            </div>
          </div>
        </div>
        <div class="flex items-center space-x-2 w-full sm:w-auto justify-end shrink-0">
          <button onclick="openActivationModal('Standard Growth Plan', '₹7,500 Setup + ₹2,999/mo', 'Autonomous B2B Sales Engine for your business')" class="text-xs font-semibold px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg transition shadow-sm whitespace-nowrap flex items-center space-x-1.5">
            <span>⚡ Upgrade Plan</span>
          </button>
          <button onclick="switchView('whatsapp')" class="text-xs font-semibold px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg transition shadow-sm whitespace-nowrap flex items-center space-x-1.5">
            <span>🟢 WhatsApp Engine</span>
          </button>
        </div>
      </div>`;

if (trialBarRegex.test(html)) {
  html = html.replace(trialBarRegex, newTrialBar);
  console.log('✓ Restored 48-Hour Live Trial status bar');
}

// 3. UPGRADE CATALOG DROPZONE TO BE FULLY CLICKABLE & DRAGGABLE
const dropzoneRegex = /<!-- UPLOAD DROPZONE -->\s*<div class="bg-white border-2 border-dashed[\s\S]*?<\/div>\s*<\/div>/;
const newDropzone = `<!-- UPLOAD DROPZONE (CLICKABLE & DRAGGABLE) -->
        <div id="catalogDropzone" onclick="document.getElementById('catalogFileInput').click()" ondragover="event.preventDefault(); this.classList.add('border-indigo-500', 'bg-indigo-50/20');" ondragleave="this.classList.remove('border-indigo-500', 'bg-indigo-50/20');" ondrop="handleCatalogDrop(event)" class="cursor-pointer bg-white border-2 border-dashed border-gray-300 rounded-xl p-6 lg:p-8 text-center hover:border-indigo-500 transition shadow-sm">
          <input type="file" id="catalogFileInput" accept=".pdf,.xlsx,.xls,.csv" class="hidden" onchange="handleCatalogFileSelected(event)">
          <div class="max-w-md mx-auto space-y-2 pointer-events-none">
            <div class="w-10 h-10 bg-indigo-50 text-indigo-600 rounded-full flex items-center justify-center mx-auto">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"/></svg>
            </div>
            <div class="text-xs lg:text-sm font-semibold text-slate-800">Drag & drop your product catalog or <span class="text-indigo-600 underline font-bold">browse</span></div>
            <div class="text-[11px] text-slate-500">Formats: PDF brochure, Excel (.xlsx, .xls), or CSV (Auto-extracts every product row!)</div>
            <div id="catalogUploadStatus" class="hidden text-xs text-indigo-600 font-semibold pt-1"></div>
          </div>
        </div>`;

if (dropzoneRegex.test(html)) {
  html = html.replace(dropzoneRegex, newDropzone);
  console.log('✓ Upgraded Catalog Dropzone to clickable + drag & drop');
}

// 4. ADD WEBSITE KNOWLEDGE BASE CARD IN #view-catalog
const websiteSyncCardHtml = `
        <!-- CONNECT BUSINESS WEBSITE CARD (OPTIONAL AI KNOWLEDGE BASE) -->
        <div class="bg-white border border-gray-200 rounded-xl p-5 shadow-sm space-y-3">
          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-2">
              <span class="text-base">🌐</span>
              <h3 class="text-sm font-bold text-slate-900">Connect Business Website (Optional AI Knowledge Base)</h3>
            </div>
            <span id="websiteSyncStatusBadge" class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">Not Connected</span>
          </div>
          <p class="text-xs text-slate-500">Enter your company website. Our AI reads your about, products, and services so it can answer customer questions directly on WhatsApp.</p>
          <div class="flex flex-col sm:flex-row gap-2">
            <input type="url" id="websiteUrlInput" placeholder="https://yourcompany.com" class="flex-1 px-3 py-2 text-xs border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:outline-none">
            <button onclick="syncWebsiteKnowledge()" id="btnSyncWebsite" class="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-semibold rounded-lg text-xs transition shadow-sm whitespace-nowrap flex items-center justify-center gap-1.5">
              <span>⚡ Sync Website Knowledge</span>
            </button>
          </div>
          <div id="websiteSyncInfo" class="hidden text-[11px] text-slate-600 p-2.5 bg-slate-50 border border-gray-100 rounded-lg">
            <!-- Synced timestamp & preview -->
          </div>
        </div>`;

if (!html.includes('id="websiteUrlInput"')) {
  const catCloseTag = '</section>\n\n      <!-- ==============================================\n      <!-- VIEW 5: WHATSAPP INTEGRATION -->';
  const catCloseTagAlt = '</section>\r\n\r\n      <!-- ==============================================\r\n      <!-- VIEW 5: WHATSAPP INTEGRATION -->';
  if (html.includes(catCloseTagAlt)) {
    html = html.replace(catCloseTagAlt, websiteSyncCardHtml + '\n      </section>\r\n\r\n      <!-- ==============================================\r\n      <!-- VIEW 5: WHATSAPP INTEGRATION -->');
  } else if (html.includes(catCloseTag)) {
    html = html.replace(catCloseTag, websiteSyncCardHtml + '\n      </section>\n\n      <!-- ==============================================\n      <!-- VIEW 5: WHATSAPP INTEGRATION -->');
  }
  console.log('✓ Added Website Knowledge Base card to #view-catalog');
}

// 5. RESTORE COMMERCIAL PLANS IN #view-billing
const billingSectionRegex = /<section id="view-billing"[\s\S]*?<\/section>/;
const newBillingSection = `<section id="view-billing" class="hidden space-y-6">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h1 class="text-xl lg:text-2xl font-bold text-slate-900 tracking-tight">Workspace Membership & Commercial Plans</h1>
            <p class="text-xs text-slate-500 mt-0.5">High-intent autonomous AI sales closing for your business inquiries.</p>
          </div>
          <div class="flex items-center gap-2">
            <span id="memStatusBadge" class="text-xs font-bold uppercase tracking-wider px-3 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">
              🎁 48-Hour Live Trial Active
            </span>
          </div>
        </div>

        <!-- CARD 1: TRIAL STATUS & LIVE LEADS USAGE BAR -->
        <div class="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 text-white shadow-sm border border-slate-800 space-y-4">
          <div class="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div class="space-y-1">
              <span class="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-emerald-500/30 text-emerald-300 border border-emerald-400/30">Live Workspace Quota</span>
              <h3 class="text-lg font-bold">48-Hour Live VIP Trial: 25 Inquiries Included</h3>
              <p class="text-xs text-slate-300">Your workspace is active. AI qualifies buyers, attaches PDF brochures, and schedules owner calls.</p>
            </div>
            <div class="text-right">
              <div class="text-xs text-slate-300">Trial Time Remaining:</div>
              <div id="memCountdownDisplay" class="text-base font-mono font-bold text-emerald-300 mt-0.5">47h 59m remaining</div>
            </div>
          </div>

          <!-- Progress bar -->
          <div class="space-y-1.5 pt-2">
            <div class="flex justify-between text-xs font-medium text-slate-300">
              <span>Trial Inquiries Processed</span>
              <span id="memLeadQuotaText" class="font-bold text-white">0 / 25 Trial Leads Used</span>
            </div>
            <div class="w-full bg-slate-800 h-2.5 rounded-full overflow-hidden border border-slate-700">
              <div id="memLeadProgressBar" class="bg-gradient-to-r from-emerald-500 to-indigo-500 h-full rounded-full transition-all duration-500" style="width: 0%;"></div>
            </div>
          </div>
        </div>

        <!-- CARD 2: 3 COMMERCIAL PLANS BENTO GRID -->
        <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
          <!-- PLAN 1: STANDARD GROWTH -->
          <div class="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-5 hover:border-indigo-300 transition">
            <div class="space-y-3">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">Standard Growth</span>
              <h3 class="text-lg font-bold text-slate-900">₹7,500 <span class="text-xs font-normal text-slate-500">Setup + ₹2,999/mo</span></h3>
              <p class="text-xs text-slate-500">Ideal for small manufacturers, wholesalers & independent distributors.</p>
              <div class="pt-2 border-t border-gray-100 text-xs space-y-2 text-slate-600">
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>500 Verified Buyer Leads / Month</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Instant PDF Brochure Dispatch (&lt;10s)</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>24×7 Hinglish AI Deal Closing</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Instant Hot-Lead WhatsApp Alerts to Owner</span></div>
              </div>
            </div>
            <button onclick="openActivationModal('Standard Growth', '₹7,500 Setup + ₹2,999/mo', 'Includes 500 inquiries/mo, PDF brochure dispatch, Hinglish deal qualification, owner alerts')" class="w-full py-2.5 bg-slate-900 hover:bg-slate-800 text-white font-semibold rounded-xl text-xs transition shadow-sm">
              Activate Standard Plan →
            </button>
          </div>

          <!-- PLAN 2: PRO MULTI-CATALOG (RECOMMENDED) -->
          <div class="bg-white border-2 border-indigo-600 rounded-2xl p-6 shadow-md flex flex-col justify-between space-y-5 relative">
            <div class="absolute -top-3 left-1/2 -translate-x-1/2 bg-indigo-600 text-white text-[10px] font-bold uppercase tracking-wider px-3 py-0.5 rounded-full shadow-sm">
              🔥 Most Popular for Growing Businesses
            </div>
            <div class="space-y-3 pt-1">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200">Pro Multi-Catalog</span>
              <h3 class="text-lg font-bold text-slate-900">₹12,000 <span class="text-xs font-normal text-slate-500">Setup + ₹4,999/mo</span></h3>
              <p class="text-xs text-slate-500">For multi-product factories, exporters, and coaching institutes.</p>
              <div class="pt-2 border-t border-gray-100 text-xs space-y-2 text-slate-600">
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Up to 2,000 Buyer Leads / Month</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Unlimited Catalogs & PDFs Ingestion</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Website Knowledge Scraper Sync</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Two-Way Director Call Scheduler</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Priority 15-Minute AnyDesk Setup</span></div>
              </div>
            </div>
            <button onclick="openActivationModal('Pro Multi-Catalog', '₹12,000 Setup + ₹4,999/mo', 'Up to 2,000 inquiries/mo, unlimited catalogs, website scraper sync, priority AnyDesk setup')" class="w-full py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-bold rounded-xl text-xs transition shadow-md">
              Activate Pro Plan →
            </button>
          </div>

          <!-- PLAN 3: ANNUAL ENTERPRISE -->
          <div class="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm flex flex-col justify-between space-y-5 hover:border-emerald-300 transition">
            <div class="space-y-3">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-800 border border-emerald-200">💎 Best Value Annual Lock-In</span>
              <h3 class="text-lg font-bold text-slate-900">₹18,000 <span class="text-xs font-normal text-slate-500">/ Year (Zero Monthly Fees)</span></h3>
              <p class="text-xs text-slate-500">Save 60%+ with unlimited inquiries and complete done-for-you concierge support.</p>
              <div class="pt-2 border-t border-gray-100 text-xs space-y-2 text-slate-600">
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Unlimited Leads & Inquiries for 1 Full Year</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Zero Setup Fee (₹5,000 Setup Waived 100% Free)</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Dedicated Senior Sales Engineer on WhatsApp & Phone</span></div>
                <div class="flex items-center gap-1.5"><span class="text-emerald-600 font-bold">✓</span><span>Custom AI Fine-Tuning & Multi-SIM Support</span></div>
              </div>
            </div>
            <button onclick="openActivationModal('Annual Lock-In Enterprise', '₹18,000/yr', 'Unlimited inquiries, dedicated sales engineer support, zero monthly fees')" class="w-full py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-xl text-xs transition shadow-sm">
              Lock In Annual Plan (Save 60%) →
            </button>
          </div>
        </div>

        <!-- PARTNER COUPON CODE UNLOCK -->
        <div class="p-5 bg-indigo-50/60 border border-indigo-100 rounded-2xl space-y-3">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h4 class="text-xs font-bold text-indigo-950">Have a Partner Coupon Code or Tailored Proposal?</h4>
              <p class="text-[11px] text-indigo-800">Enter your partner coupon code or activation reference to unlock your discounted rate.</p>
            </div>
            <div class="flex items-center space-x-2">
              <input type="text" id="offerCodeInput" placeholder="e.g. VIP999" class="px-3 py-1.5 text-xs border border-indigo-200 rounded-lg uppercase font-mono font-bold focus:ring-2 focus:ring-indigo-500 focus:outline-none">
              <button onclick="submitActivationCode()" class="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold shadow-sm transition">
                Apply
              </button>
            </div>
          </div>

          <!-- Tailored Invoice Banner (If custom_quote_inr is active) -->
          <div id="customQuoteBanner" class="hidden p-3 bg-white border border-emerald-300 rounded-lg flex items-center justify-between">
            <div>
              <span class="text-[10px] font-bold text-emerald-700 uppercase bg-emerald-50 px-2 py-0.5 rounded">Tailored Proposal Unlocked</span>
              <div class="text-sm font-bold text-slate-900 mt-0.5">Special Factory Activation: <span id="customQuoteAmountText" class="text-indigo-600 font-extrabold">₹999</span></div>
              <div id="customQuoteDescText" class="text-[11px] text-emerald-800 font-medium mt-0.5">48-Hour VIP Engineer Setup Deposit — Adjusted in Plan</div>
            </div>
            <button onclick="openActivationModal('Tailored Factory License', document.getElementById('customQuoteAmountText').textContent, document.getElementById('customQuoteDescText')?.textContent || 'Custom Tailored Factory Activation')" class="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold rounded-lg shadow-sm transition">
              Activate Now →
            </button>
          </div>
        </div>
      </section>`;

if (billingSectionRegex.test(html)) {
  html = html.replace(billingSectionRegex, newBillingSection);
  console.log('✓ Restored 3 Commercial Plans in #view-billing');
}

// 6. HIDE RAZORPAY TAB IN #activationModal & MAKE DIRECT UPI THE SINGLE PRIMARY CHECKOUT
const payTabBtnsRegex = /<div class="flex border-b border-gray-200 text-xs font-semibold">\s*<button id="payTabUpiBtn"[\s\S]*?<\/button>\s*<\/div>/;
const newPayTabBtns = `<div class="flex border-b border-gray-200 text-xs font-semibold">
        <button id="payTabUpiBtn" onclick="switchPayTab('upi')" class="flex-1 py-2.5 text-center border-b-2 border-indigo-600 text-indigo-600 font-bold transition flex items-center justify-center space-x-1.5">
          <span>⚡ Instant Direct UPI QR (0% MDR • Zero Fees)</span>
        </button>
        <button id="payTabRazorpayBtn" onclick="switchPayTab('razorpay')" class="hidden flex-1 py-2.5 text-center border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition items-center justify-center space-x-1.5">
          <span>💳 Razorpay</span>
        </button>
      </div>`;
if (payTabBtnsRegex.test(html)) {
  html = html.replace(payTabBtnsRegex, newPayTabBtns);
  console.log('✓ Updated payment method tabs in #activationModal');
}

// 7. ADD EDIT PRODUCT MODAL
const editProductModalHtml = `
  <!-- EDIT PRODUCT SKU MODAL -->
  <div id="editProductModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-50 hidden flex items-center justify-center p-4">
    <div class="bg-white border border-gray-200 rounded-2xl max-w-md w-full p-6 shadow-2xl relative">
      <button onclick="closeEditProductModal()" class="absolute top-4 right-4 text-slate-400 hover:text-slate-600">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>

      <div class="space-y-4">
        <h2 class="text-lg font-bold text-slate-900">Edit Catalog Product</h2>
        <p class="text-xs text-slate-500">Update pricing, model specs, or attachments for this SKU.</p>
        <input type="hidden" id="editProductId">
        <div class="space-y-3 text-xs">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block font-semibold text-slate-700 mb-1">SKU / Code</label>
              <input type="text" id="editSku" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs font-mono">
            </div>
            <div>
              <label class="block font-semibold text-slate-700 mb-1">Price Specification</label>
              <input type="text" id="editPriceRaw" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs">
            </div>
          </div>
          <div>
            <label class="block font-semibold text-slate-700 mb-1">Machine / Product Name <span class="text-rose-500">*</span></label>
            <input type="text" id="editProductName" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs">
          </div>
          <div>
            <label class="block font-semibold text-slate-700 mb-1">Model / Specs / Capacity Details</label>
            <textarea id="editModel" rows="2" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs"></textarea>
          </div>
          <button id="editSubmitBtn" onclick="submitEditProduct()" class="w-full py-2.5 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 shadow-sm transition flex items-center justify-center gap-2">
            <span>💾 Save Changes</span>
          </button>
        </div>
      </div>
    </div>
  </div>`;

if (!html.includes('id="editProductModal"')) {
  const qModalClose = '</div>\n  </div>\n\n  <!-- HIGH-TRUST PAYMENT';
  const qModalCloseAlt = '</div>\r\n  </div>\r\n\r\n  <!-- HIGH-TRUST PAYMENT';
  if (html.includes(qModalCloseAlt)) {
    html = html.replace(qModalCloseAlt, '</div>\r\n  </div>\r\n' + editProductModalHtml + '\r\n\r\n  <!-- HIGH-TRUST PAYMENT');
  } else if (html.includes(qModalClose)) {
    html = html.replace(qModalClose, '</div>\n  </div>\n' + editProductModalHtml + '\n\n  <!-- HIGH-TRUST PAYMENT');
  }
  console.log('✓ Added #editProductModal');
}

// 8. ADD BUSINESS TYPE SELECTOR IN #view-settings
const nicheSelectorHtml = `
              <div>
                <label class="block font-semibold text-slate-700 mb-1">Business Industry / Niche</label>
                <select id="settingBusinessType" onchange="saveBusinessType()" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs bg-white focus:ring-2 focus:ring-indigo-500 focus:outline-none">
                  <option value="auto">✨ Auto-Detect from Catalog</option>
                  <option value="machinery">⚙️ Industrial Machinery & Equipment</option>
                  <option value="coaching_ielts">🎓 Coaching, IELTS & Education Academy</option>
                  <option value="goods">📦 Garments, Goods & Wholesale Products</option>
                  <option value="services">💼 Professional Services, Solar & Real Estate</option>
                </select>
                <p class="text-[10px] text-slate-400 mt-0.5">Reshapes table headers, AI questions, and tone to fit your exact market.</p>
              </div>`;

if (!html.includes('id="settingBusinessType"')) {
  const targetSettingField = '<input type="text" id="settingCity"';
  const parentContainer = '<div>\r\n                <label class="block font-semibold text-slate-700 mb-1">Dispatch Hub / Primary City</label>';
  const parentContainerLf = '<div>\n                <label class="block font-semibold text-slate-700 mb-1">Dispatch Hub / Primary City</label>';
  if (html.includes(parentContainer)) {
    html = html.replace(parentContainer, nicheSelectorHtml + '\r\n              ' + parentContainer);
  } else if (html.includes(parentContainerLf)) {
    html = html.replace(parentContainerLf, nicheSelectorHtml + '\n              ' + parentContainerLf);
  }
  console.log('✓ Added Business Industry / Niche selector in #view-settings');
}

// 9. UPDATE DEFAULT TEST MESSAGE IN "Send Live Test WhatsApp Now" TO DYNAMIC
html = html.replace(
  'Namaste! This is a live test message from your MartFlow AI Factory Sales Engine.',
  'Namaste! This is a live test message from your MartFlow AI Sales Engine.'
);

fs.writeFileSync(indexPath, html, 'utf8');
console.log('✓ Frontend HTML structure updated successfully!');
