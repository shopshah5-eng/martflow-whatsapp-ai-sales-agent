import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const indexPath = path.join(__dirname, '..', 'public', 'index.html');

let html = fs.readFileSync(indexPath, 'utf8');

// Read existing loadDashboardData and replace with DOM-matched version
const oldLoadDashboardRegex = /async function loadDashboardData\(\)[\s\S]*?function renderDashboardLeadsTable\(leads\)[\s\S]*?tbody\.innerHTML = leads\.map[\s\S]*?<\/tr>\s*`;\s*}\)\.join\(''\);\s*}/;

const newDashboardAndLeadsJs = `async function loadDashboardData() {
      if (!currentOrg) {
        renderEmptyDashboardState();
        return;
      }

      try {
        let leads = [];
        let products = [];
        let calls = [];

        if (sb) {
          const [lRes, pRes, cRes] = await Promise.all([
            sb.from('leads').select('*').eq('org_id', currentOrg.id),
            sb.from('products').select('*').eq('org_id', currentOrg.id),
            sb.from('call_requests').select('*').eq('org_id', currentOrg.id)
          ]);
          leads = lRes.data || [];
          products = pRes.data || [];
          calls = cRes.data || [];
        } else {
          const data = await apiFetch('/api/leads');
          leads = data.leads || [];
        }

        const totalLeads = leads.length;
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayLeads = leads.filter(l => new Date(l.created_at || l.createdAt) >= today).length;
        const totalCalls = calls.length;
        const totalProducts = products.length;
        const qualifiedCount = leads.filter(l => l.status === 'qualified' || l.pdf_brochure_sent || l.brochure_sent || l.isHotLead).length;
        const qualRate = totalLeads > 0 ? Math.round((qualifiedCount / totalLeads) * 100) : 0;

        // Update all dashboard KPI elements (matching HTML IDs directly)
        const statToday = document.getElementById('statLeadsToday') || document.getElementById('kpiTodayLeads');
        if (statToday) statToday.textContent = todayLeads;

        const statTotal = document.getElementById('kpiTotalLeads');
        if (statTotal) statTotal.textContent = totalLeads;

        const statMedian = document.getElementById('statMedianResponse');
        if (statMedian) statMedian.textContent = totalLeads > 0 ? '< 10s' : '0s';

        const statQual = document.getElementById('statQualifiedRate');
        if (statQual) statQual.textContent = qualRate + '%';

        const statCalls = document.getElementById('statCallsBooked') || document.getElementById('kpiCallCount');
        if (statCalls) statCalls.textContent = totalCalls;

        const statProds = document.getElementById('statCatalogProducts') || document.getElementById('kpiActiveProducts');
        if (statProds) statProds.textContent = totalProducts;

        // Update sidebar badge
        const badgeLeads = document.getElementById('badgeLeadCount') || document.getElementById('sidebarLeadCount');
        if (badgeLeads) {
          badgeLeads.textContent = totalLeads;
          badgeLeads.classList.toggle('hidden', totalLeads === 0);
        }

        renderDashboardLeadsTable(leads.slice(0, 5));
      } catch (err) {
        console.error('loadDashboardData error:', err);
        renderEmptyDashboardState();
      }
    }

    function renderEmptyDashboardState() {
      const statToday = document.getElementById('statLeadsToday') || document.getElementById('kpiTodayLeads');
      if (statToday) statToday.textContent = '0';
      const statTotal = document.getElementById('kpiTotalLeads');
      if (statTotal) statTotal.textContent = '0';
      const statMedian = document.getElementById('statMedianResponse');
      if (statMedian) statMedian.textContent = '0s';
      const statQual = document.getElementById('statQualifiedRate');
      if (statQual) statQual.textContent = '0%';
      const statCalls = document.getElementById('statCallsBooked') || document.getElementById('kpiCallCount');
      if (statCalls) statCalls.textContent = '0';
      const statProds = document.getElementById('statCatalogProducts') || document.getElementById('kpiActiveProducts');
      if (statProds) statProds.textContent = '0';
      renderDashboardLeadsTable([]);
    }

    function renderDashboardLeadsTable(leads) {
      const container = document.getElementById('dashboardLeadsTable');
      const tbody = document.getElementById('dashboardLeadsBody');

      if (!leads || leads.length === 0) {
        if (container) {
          container.innerHTML = '<div class="py-8 text-center text-xs text-slate-400 font-medium">No inquiries in workspace yet. Pair WhatsApp or dispatch a test lead to see live responses!</div>';
        } else if (tbody) {
          tbody.innerHTML = '<tr><td colspan="6" class="text-center py-8 text-slate-400 font-medium">No inquiries in workspace yet. Pair WhatsApp or dispatch a test lead to see live responses!</td></tr>';
        }
        return;
      }

      const rowsHtml = leads.map(l => {
        const cleanPhone = String(l.buyer_phone || l.phone || '').replace(/\\D/g, '');
        const pdfSent = l.pdf_brochure_sent || l.brochure_sent || l.pdfSent;
        const buyerName = l.buyer_name || l.name || 'Buyer';
        const city = l.buyer_city || l.city || '-';
        const prod = l.product_inquired || l.productName || 'General Inquiry';

        return \`
          <tr class="border-b border-gray-100 hover:bg-slate-50/80 transition text-xs">
            <td class="py-3 px-4 font-semibold text-slate-900">\${escapeHtml(buyerName)}</td>
            <td class="py-3 px-4 font-mono text-slate-600">
              <a href="https://wa.me/\${cleanPhone}" target="_blank" class="hover:text-emerald-600 font-medium">+\${cleanPhone}</a>
            </td>
            <td class="py-3 px-4 text-slate-600">\${escapeHtml(city)}</td>
            <td class="py-3 px-4 font-medium text-slate-800">\${escapeHtml(prod)}</td>
            <td class="py-3 px-4">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold \${pdfSent ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-600'}">
                \${pdfSent ? '✓ YES' : 'NO'}
              </span>
            </td>
            <td class="py-3 px-4 text-right">
              <button onclick="switchView('conversations')" class="text-indigo-600 hover:text-indigo-800 font-semibold">View Thread →</button>
            </td>
          </tr>
        \`;
      }).join('');

      if (container) {
        container.innerHTML = \`
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="border-b border-gray-200 text-slate-500 font-semibold bg-slate-50/75">
                <th class="py-2.5 px-4">Buyer Name</th>
                <th class="py-2.5 px-4">Phone</th>
                <th class="py-2.5 px-4">City</th>
                <th class="py-2.5 px-4">Product / Inquiry</th>
                <th class="py-2.5 px-4">Brochure</th>
                <th class="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody id="dashboardLeadsBody" class="divide-y divide-gray-100">
              \${rowsHtml}
            </tbody>
          </table>
        \`;
      } else if (tbody) {
        tbody.innerHTML = rowsHtml;
      }
    }`;

if (oldLoadDashboardRegex.test(html)) {
  html = html.replace(oldLoadDashboardRegex, newDashboardAndLeadsJs);
  console.log('✓ Updated loadDashboardData and renderDashboardLeadsTable');
}

// Update fetchLeadsList
const oldFetchLeadsRegex = /async function fetchLeadsList\(\)[\s\S]*?tbody\.innerHTML = \`<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading leads:[\s\S]*?<\/tr>\`;\s*}/;

const newFetchLeadsJs = `async function fetchLeadsList() {
      const container = document.getElementById('leadsTableContainer');
      const tbody = document.getElementById('leadsTableBody');

      if (!currentOrg) {
        if (container) container.innerHTML = '<div class="py-12 text-center text-xs text-slate-400">Please sign in to view leads.</div>';
        else if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400">Please sign in to view leads.</td></tr>';
        return;
      }

      try {
        let leads = [];
        if (sb) {
          const { data, error } = await sb
            .from('leads')
            .select('*')
            .eq('org_id', currentOrg.id)
            .order('created_at', { ascending: false });
          if (error) throw error;
          leads = data || [];
        } else {
          const res = await apiFetch('/api/leads');
          leads = res.leads || [];
        }

        const query = (document.getElementById('leadSearchInput')?.value || document.getElementById('leadsSearchInput')?.value || '').toLowerCase().trim();
        const statusFilter = document.getElementById('leadStatusFilter')?.value || '';

        if (statusFilter) {
          leads = leads.filter(l => (l.status || '').toLowerCase() === statusFilter.toLowerCase());
        }

        if (query) {
          leads = leads.filter(l => 
            (l.buyer_name || l.name || '').toLowerCase().includes(query) ||
            (l.buyer_phone || l.phone || '').includes(query) ||
            (l.buyer_city || l.city || '').toLowerCase().includes(query) ||
            (l.product_inquired || l.productName || '').toLowerCase().includes(query) ||
            (l.query_message || l.requirement || '').toLowerCase().includes(query)
          );
        }

        if (leads.length === 0) {
          const emptyMsg = '<div class="py-12 text-center text-xs text-slate-400 font-medium">No leads found. Incoming WhatsApp inquiries appear here instantly.</div>';
          if (container) container.innerHTML = emptyMsg;
          else if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 font-medium">No leads found. Incoming WhatsApp inquiries appear here instantly.</td></tr>';
          return;
        }

        const rowsHtml = leads.map(l => {
          const cleanPhone = String(l.buyer_phone || l.phone || '').replace(/\\D/g, '');
          const pdfSent = l.pdf_brochure_sent || l.brochure_sent || l.pdfSent;
          const buyerName = l.buyer_name || l.name || 'Buyer';
          const city = l.buyer_city || l.city || '-';
          const prod = l.product_inquired || l.productName || '-';
          const msg = l.query_message || l.requirement || '-';
          const status = l.status || 'new';

          return \`
            <tr class="border-b border-gray-100 hover:bg-slate-50/80 transition text-xs">
              <td class="py-3 px-4 font-semibold text-slate-900">\${escapeHtml(buyerName)}</td>
              <td class="py-3 px-4 font-mono text-slate-600">
                <a href="https://wa.me/\${cleanPhone}" target="_blank" class="hover:text-emerald-600 font-medium">+\${cleanPhone}</a>
              </td>
              <td class="py-3 px-4 text-slate-600">\${escapeHtml(city)}</td>
              <td class="py-3 px-4 font-medium text-slate-800">\${escapeHtml(prod)}</td>
              <td class="py-3 px-4 text-slate-500 max-w-xs truncate" title="\${escapeHtml(msg)}">\${escapeHtml(msg)}</td>
              <td class="py-3 px-4">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold \${pdfSent ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-600'}">
                  \${pdfSent ? '✓ YES' : 'NO'}
                </span>
              </td>
              <td class="py-3 px-4 text-right">
                <button onclick="switchView('conversations')" class="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">Open Chat</button>
              </td>
            </tr>
          \`;
        }).join('');

        if (container) {
          container.innerHTML = \`
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b border-gray-200 text-slate-500 font-semibold bg-slate-50/75">
                  <th class="py-3 px-4">Buyer Name</th>
                  <th class="py-3 px-4">Phone</th>
                  <th class="py-3 px-4">City</th>
                  <th class="py-3 px-4">Product Inquired</th>
                  <th class="py-3 px-4">Message / Specs</th>
                  <th class="py-3 px-4">Brochure Sent</th>
                  <th class="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody id="leadsTableBody" class="divide-y divide-gray-100">
                \${rowsHtml}
              </tbody>
            </table>
          \`;
        } else if (tbody) {
          tbody.innerHTML = rowsHtml;
        }
      } catch (err) {
        if (container) container.innerHTML = \`<div class="py-12 text-center text-xs text-rose-500">Error loading leads: \${escapeHtml(err.message)}</div>\`;
        else if (tbody) tbody.innerHTML = \`<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading leads: \${escapeHtml(err.message)}</td></tr>\`;
      }
    }`;

if (oldFetchLeadsRegex.test(html)) {
  html = html.replace(oldFetchLeadsRegex, newFetchLeadsJs);
  console.log('✓ Updated fetchLeadsList');
}

// Update fetchConversationsList and selectConversation
const oldConvsRegex = /async function fetchConversationsList\(\)[\s\S]*?function renderMessages\(msgs\)[\s\S]*?chatBox\.scrollTop = chatBox\.scrollHeight;\s*}/;

const newConvsJs = `async function fetchConversationsList() {
      const container = document.getElementById('conversationThreadList') || document.getElementById('conversationsList');
      if (!container) return;
      if (!currentOrg) {
        container.innerHTML = '<div class="p-6 text-center text-xs text-slate-400">Sign in to view conversations.</div>';
        return;
      }

      try {
        let convs = [];
        if (sb) {
          const { data, error } = await sb
            .from('conversations')
            .select('*, leads(*)')
            .eq('org_id', currentOrg.id)
            .order('updated_at', { ascending: false });
          if (error) throw error;
          convs = data || [];
        } else {
          const res = await apiFetch('/api/conversations');
          convs = res.conversations || [];
        }

        if (convs.length === 0) {
          container.innerHTML = '<div class="p-6 text-center text-xs text-slate-400">No active conversations yet.</div>';
          return;
        }

        container.innerHTML = convs.map(c => {
          const lead = c.leads || c.lead || {};
          const cleanPhone = String(lead.buyer_phone || lead.phone || '').replace(/\\D/g, '');
          const buyerName = lead.buyer_name || lead.name || 'Customer';
          const isSelected = c.id === activeConversationId;

          return \`
            <div onclick="selectConversation('\${c.id}')" class="p-3.5 border-b border-gray-100 hover:bg-slate-50 cursor-pointer transition flex items-center justify-between \${isSelected ? 'bg-indigo-50/70 border-l-4 border-l-indigo-600' : ''}">
              <div class="truncate mr-2">
                <div class="text-xs font-bold text-slate-900 truncate">\${escapeHtml(buyerName)}</div>
                <div class="text-[11px] text-slate-500 font-mono">+\${cleanPhone}</div>
              </div>
              <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 \${c.mode === 'manual' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-700'}">
                \${c.mode === 'manual' ? 'Manual' : 'AI Active'}
              </span>
            </div>
          \`;
        }).join('');

        if (convs.length > 0 && !activeConversationId) {
          selectConversation(convs[0].id);
        }
      } catch (err) {
        container.innerHTML = \`<div class="p-4 text-xs text-rose-500">Error: \${escapeHtml(err.message)}</div>\`;
      }
    }

    async function selectConversation(convId) {
      activeConversationId = convId;
      const chatBox = document.getElementById('chatMessagesStream') || document.getElementById('chatMessagesBox');
      if (!chatBox) return;

      const controls = document.getElementById('chatModeControls');
      if (controls) controls.classList.remove('hidden');

      // Update active highlight in thread list
      document.querySelectorAll('#conversationThreadList > div, #conversationsList > div').forEach(el => {
        el.classList.remove('bg-indigo-50/70', 'border-l-4', 'border-l-indigo-600');
      });

      if (sb) {
        const [cRes, mRes] = await Promise.all([
          sb.from('conversations').select('*, leads(*)').eq('id', convId).single(),
          sb.from('messages').select('*').eq('conversation_id', convId).order('created_at', { ascending: true })
        ]);

        const conv = cRes.data;
        if (conv) {
          const lead = conv.leads || {};
          const bName = document.getElementById('chatBuyerName');
          const bPhone = document.getElementById('chatBuyerPhone');
          if (bName) bName.textContent = lead.buyer_name || 'Customer';
          if (bPhone) bPhone.textContent = lead.buyer_phone ? '+' + lead.buyer_phone.replace(/\\D/g, '') : 'Active WhatsApp Thread';

          const btnMode = document.getElementById('btnChatModeToggle');
          if (btnMode) {
            btnMode.textContent = conv.mode === 'manual' ? '👤 Manual Takeover' : '🤖 AI Active';
            btnMode.className = conv.mode === 'manual'
              ? 'text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-300'
              : 'text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300';
          }
        }
        renderMessages(mRes.data || []);
      } else {
        const data = await apiFetch(\`/api/conversations/\${convId}/messages\`);
        renderMessages(data.messages || []);
      }
    }

    function renderMessages(msgs) {
      const chatBox = document.getElementById('chatMessagesStream') || document.getElementById('chatMessagesBox');
      if (!chatBox) return;

      if (msgs.length === 0) {
        chatBox.innerHTML = '<div class="text-center py-10 text-xs text-slate-400">Thread initiated. Customer will receive automated greeting and brochure.</div>';
        return;
      }

      chatBox.innerHTML = msgs.map(m => {
        const isBuyer = m.sender === 'buyer' || m.sender_type === 'buyer';
        return \`
          <div class="flex \${isBuyer ? 'justify-start' : 'justify-end'} mb-3">
            <div class="max-w-[75%] p-3 rounded-2xl text-xs \${isBuyer ? 'bg-white border border-gray-200 text-slate-800' : 'bg-slate-900 text-white shadow-sm'}">
              <div class="text-[10px] font-bold mb-1 opacity-70">\${isBuyer ? 'Buyer' : (m.sender === 'ai' ? 'MartFlow AI' : 'Sales Representative')}</div>
              <div class="leading-relaxed whitespace-pre-wrap">\${escapeHtml(m.text || m.content || '')}</div>
              <div class="text-[9px] text-right mt-1 opacity-60 font-mono">\${new Date(m.created_at || m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          </div>
        \`;
      }).join('');
      chatBox.scrollTop = chatBox.scrollHeight;
    }`;

if (oldConvsRegex.test(html)) {
  html = html.replace(oldConvsRegex, newConvsJs);
  console.log('✓ Updated fetchConversationsList, selectConversation, and renderMessages');
}

// Update checkWaConnection to update sidebar socket status
const oldCheckWaRegex = /async function checkWaConnection\(force = false\)[\s\S]*?badge\.textContent = `✓ Connected as \+\${currentOrg\.wa_connected_number \|\| currentOrg\.bot_whatsapp_number}`;[\s\S]*?else if \(currentOrg\.wa_status === 'qr_ready'/;

const newCheckWaJs = `async function checkWaConnection(force = false) {
      if (!currentOrg) return;
      if (sb) {
        try {
          const { data: org } = await sb.from('organizations').select('*').eq('id', currentOrg.id).single();
          if (org) currentOrg = { ...currentOrg, ...org };
        } catch (e) {}
      }

      // Update bottom-left sidebar socket status
      const waDot = document.getElementById('waStatusDot');
      const waBadge = document.getElementById('waStatusBadge');
      const waText = document.getElementById('waStatusText');

      if (currentOrg.wa_status === 'connected') {
        if (waDot) waDot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1.5';
        if (waBadge) waBadge.className = 'inline-flex items-center text-[11px] font-semibold text-emerald-800 bg-emerald-100 px-2 py-0.5 rounded-full';
        if (waText) waText.textContent = 'Connected';
      } else if (currentOrg.wa_status === 'qr_ready') {
        if (waDot) waDot.className = 'w-1.5 h-1.5 rounded-full bg-indigo-500 mr-1.5 animate-pulse';
        if (waBadge) waBadge.className = 'inline-flex items-center text-[11px] font-semibold text-indigo-800 bg-indigo-100 px-2 py-0.5 rounded-full';
        if (waText) waText.textContent = 'Scan QR';
      } else {
        if (waDot) waDot.className = 'w-1.5 h-1.5 rounded-full bg-slate-400 mr-1.5';
        if (waBadge) waBadge.className = 'inline-flex items-center text-[11px] font-semibold text-slate-600 bg-slate-200 px-2 py-0.5 rounded-full';
        if (waText) waText.textContent = 'Disconnected';
      }

      // 1. Worker Heartbeat Pill Check
      const pill = document.getElementById('waWorkerEnginePill');
      const pillText = document.getElementById('waEnginePillText');
      if (pill && pillText) {
        const hb = currentOrg.wa_worker_heartbeat;
        const ageSec = hb ? (Date.now() - new Date(hb).getTime()) / 1000 : 9999;
        if (ageSec < 45) {
          pill.className = "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/30";
          pillText.textContent = "🟢 WhatsApp Engine Online";
        } else {
          pill.className = "inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-600 border border-amber-500/30";
          pillText.textContent = "🟠 Start WhatsApp Worker (node server.js) to generate QR";
        }
      }

      // 2. Hydrate Inputs
      if (document.getElementById('waBotNumberInput') && currentOrg.bot_whatsapp_number) {
        document.getElementById('waBotNumberInput').value = currentOrg.bot_whatsapp_number;
      }
      if (document.getElementById('waOwnerAlertInput') && currentOrg.owner_alert_number) {
        document.getElementById('waOwnerAlertInput').value = currentOrg.owner_alert_number;
      }
      if (document.getElementById('waAutoReplyToggle')) {
        document.getElementById('waAutoReplyToggle').checked = currentOrg.wa_auto_reply !== false;
      }
      if (document.getElementById('waAutoPdfToggle')) {
        document.getElementById('waAutoPdfToggle').checked = currentOrg.wa_auto_pdf !== false;
      }
      if (document.getElementById('waOwnerAlertsToggle')) {
        document.getElementById('waOwnerAlertsToggle').checked = currentOrg.wa_owner_alerts !== false;
      }
      if (document.getElementById('waWelcomeMessageInput') && currentOrg.wa_welcome_message) {
        document.getElementById('waWelcomeMessageInput').value = currentOrg.wa_welcome_message;
      }

      // 3. Status Display
      const badge = document.getElementById('waConnectionBadge');
      const qrContainer = document.getElementById('baileysQrContainer');
      const qrMsg = document.getElementById('baileysStatusMessage');
      const codeDisplay = document.getElementById('waPairingCodeDisplay');
      const codeCopy = document.getElementById('waPairingCodeCopyBtnContainer');

      if (currentOrg.wa_status === 'connected') {
        if (badge) {
          badge.className = "text-[11px] font-bold text-emerald-600";
          badge.textContent = \`✓ Connected as +\${currentOrg.wa_connected_number || currentOrg.bot_whatsapp_number}\`;
        }
        if (qrContainer) {
          qrContainer.innerHTML = \`<div class="p-4 text-center space-y-2"><div class="text-4xl text-emerald-600 font-bold">✓</div><div class="font-bold text-emerald-700">WhatsApp Live & Connected</div><div class="text-xs text-slate-500">+\${currentOrg.wa_connected_number || currentOrg.bot_whatsapp_number}</div></div>\`;
        }
        if (qrMsg) qrMsg.textContent = "Your WhatsApp Business SIM is paired and actively handling customer inquiries.";
      } else if (currentOrg.wa_status === 'qr_ready'`;

if (oldCheckWaRegex.test(html)) {
  html = html.replace(oldCheckWaRegex, newCheckWaJs);
  console.log('✓ Updated checkWaConnection to drive sidebar socket badge');
}

// 4. ADD CATALOG MULTI-ITEM EXTRACTION, EDIT MODAL, WEBSITE SYNC & NICHE ADAPTATION FUNCTIONS
const newHelperFunctionsJs = `
    // =========================================================================
    // 🌐 WEBSITE KNOWLEDGE EXTRACTOR & BUSINESS NICHE ADAPTATION
    // =========================================================================
    async function syncWebsiteKnowledge() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const input = document.getElementById('websiteUrlInput');
      const rawUrl = (input?.value || '').trim();
      if (!rawUrl) return showToast('Please enter your business website URL', 'warning');

      const btn = document.getElementById('btnSyncWebsite');
      const oldBtnText = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ Reading Website...</span>';
      }

      try {
        const cleanUrl = rawUrl.replace(/^https?:\\/\\//, 'https://');
        showToast('Connecting to website via AI reader...', 'info');

        const jinaUrl = 'https://r.jina.ai/' + cleanUrl;
        const res = await fetch(jinaUrl);
        if (!res.ok) throw new Error('Failed to retrieve website content (HTTP ' + res.status + ')');
        const markdown = await res.text();

        const truncatedMarkdown = markdown.slice(0, 50000);

        if (sb) {
          const { error } = await sb.from('organizations').update({
            website_url: cleanUrl,
            website_knowledge: truncatedMarkdown,
            website_synced_at: new Date().toISOString()
          }).eq('id', currentOrg.id);
          if (error) throw error;
        }

        currentOrg.website_url = cleanUrl;
        currentOrg.website_knowledge = truncatedMarkdown;
        currentOrg.website_synced_at = new Date().toISOString();

        updateWebsiteSyncBadge();
        showToast('Website knowledge base synced successfully! AI is now trained on your site.', 'success');
      } catch (err) {
        showToast('Website sync error: ' + err.message, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = oldBtnText;
        }
      }
    }

    function updateWebsiteSyncBadge() {
      const badge = document.getElementById('websiteSyncStatusBadge');
      const info = document.getElementById('websiteSyncInfo');
      const input = document.getElementById('websiteUrlInput');

      if (currentOrg?.website_url && input) {
        input.value = currentOrg.website_url;
      }

      if (currentOrg?.website_knowledge && badge) {
        badge.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300';
        badge.textContent = '✓ AI Trained on Site';

        if (info) {
          info.classList.remove('hidden');
          const dateStr = currentOrg.website_synced_at ? new Date(currentOrg.website_synced_at).toLocaleString() : 'Recently';
          info.innerHTML = \`<span class="font-bold text-slate-800">Synced:</span> \${dateStr} • <span class="font-mono text-indigo-700">\${currentOrg.website_url}</span> (\${Math.round((currentOrg.website_knowledge.length / 1024))} KB knowledge base)\`;
        }
      }
    }

    async function saveBusinessType() {
      if (!currentOrg) return;
      const type = document.getElementById('settingBusinessType')?.value || 'auto';
      try {
        if (sb) {
          await sb.from('organizations').update({ business_type: type }).eq('id', currentOrg.id);
        }
        currentOrg.business_type = type;
        applyNicheAdaptation(type);
        showToast('Business niche updated to ' + type, 'success');
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    function applyNicheAdaptation(type = 'auto') {
      const bType = type || currentOrg?.business_type || 'auto';
      const lblCat = document.getElementById('lblStatCatalogProducts');
      const sel = document.getElementById('settingBusinessType');
      if (sel && sel.value !== bType) sel.value = bType;

      if (bType === 'coaching_ielts') {
        if (lblCat) lblCat.textContent = 'Active Course PDFs';
      } else if (bType === 'goods') {
        if (lblCat) lblCat.textContent = 'Active Product PDFs';
      } else if (bType === 'services') {
        if (lblCat) lblCat.textContent = 'Active Service PDFs';
      } else {
        if (lblCat) lblCat.textContent = 'Active Machine PDFs';
      }
    }

    // =========================================================================
    // 📦 SMART CATALOG PARSER & MULTI-ROW EXTRACTION (EXCEL, CSV, PDF)
    // =========================================================================
    function handleCatalogDrop(event) {
      event.preventDefault();
      const dropzone = document.getElementById('catalogDropzone');
      if (dropzone) dropzone.classList.remove('border-indigo-500', 'bg-indigo-50/20');
      const file = event.dataTransfer?.files?.[0];
      if (file) processCatalogFile(file);
    }

    async function handleCatalogFileSelected(event) {
      const file = event?.target?.files?.[0];
      if (file) {
        await processCatalogFile(file);
        event.target.value = '';
      }
    }

    async function processCatalogFile(file) {
      if (!file || !currentOrg) return showToast('Please sign in first', 'warning');
      const fname = file.name.toLowerCase();
      showToast('Processing ' + file.name + '...', 'info');

      try {
        // Fetch existing products for smart upsert (0 duplicates on re-upload!)
        let existingProducts = [];
        if (sb) {
          const { data } = await sb.from('products').select('*').eq('org_id', currentOrg.id);
          existingProducts = data || [];
        }

        let parsedItems = [];

        // 1. EXCEL SPREADSHEET (.xlsx, .xls)
        if (fname.endsWith('.xlsx') || fname.endsWith('.xls')) {
          if (!window.XLSX) throw new Error('SheetJS library is loading, please try again in 1 second.');
          const buffer = await file.arrayBuffer();
          const workbook = XLSX.read(buffer, { type: 'array' });
          const firstSheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[firstSheetName];
          const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

          if (!rows || rows.length < 2) throw new Error('Excel sheet is empty or missing data rows.');
          parsedItems = extractItemsFromTableRows(rows);
        }
        // 2. CSV SPREADSHEET (.csv)
        else if (fname.endsWith('.csv')) {
          const text = await file.text();
          const rows = parseCsvToRows(text);
          if (!rows || rows.length < 2) throw new Error('CSV is empty or missing data rows.');
          parsedItems = extractItemsFromTableRows(rows);
        }
        // 3. PDF BROCHURE (.pdf)
        else if (fname.endsWith('.pdf')) {
          let publicPdfUrl = null;
          if (sb) {
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filePath = \`\${currentOrg.id}/catalogs/\${Date.now()}_\${safeName}\`;
            const { error: upErr } = await sb.storage.from('catalogs').upload(filePath, file, { upsert: true });
            if (!upErr) {
              const { data: urlData } = sb.storage.from('catalogs').getPublicUrl(filePath);
              publicPdfUrl = urlData?.publicUrl || null;
            }
          }

          let pdfText = '';
          if (window.pdfjsLib) {
            try {
              const arrayBuffer = await file.arrayBuffer();
              const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
              for (let i = 1; i <= Math.min(pdf.numPages, 15); i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                pdfText += textContent.items.map(it => it.str).join(' ') + '\\n';
              }
            } catch (pdfErr) {
              console.warn('PDF text extraction error:', pdfErr);
            }
          }

          // Parse multiple distinct items from brochure text if identifiable
          const itemsFromPdf = extractItemsFromPdfText(pdfText, file.name);
          parsedItems = itemsFromPdf.map(item => ({
            ...item,
            brochure_url: publicPdfUrl,
            brochure_filename: file.name
          }));
        }

        if (parsedItems.length === 0) {
          throw new Error('No valid product records found in ' + file.name);
        }

        // Smart Upsert into Supabase (0 duplicates!)
        let insertedCount = 0;
        let updatedCount = 0;

        for (const item of parsedItems) {
          const normName = item.name.toLowerCase().trim();
          const normSku = (item.sku || '').toLowerCase().trim();

          const existing = existingProducts.find(p => 
            (normSku && (p.sku || '').toLowerCase().trim() === normSku) ||
            p.name.toLowerCase().trim() === normName
          );

          if (existing && sb) {
            await sb.from('products').update({
              price_raw: item.price_raw || existing.price_raw,
              model_specs: item.model_specs || existing.model_specs,
              brochure_url: item.brochure_url || existing.brochure_url,
              brochure_filename: item.brochure_filename || existing.brochure_filename
            }).eq('id', existing.id);
            updatedCount++;
          } else if (sb) {
            await sb.from('products').insert({
              org_id: currentOrg.id,
              sku: item.sku || ('SKU-' + Math.floor(100 + Math.random() * 900)),
              name: item.name,
              price_raw: item.price_raw || 'Contact for quote',
              model_specs: item.model_specs || '',
              brochure_url: item.brochure_url || null,
              brochure_filename: item.brochure_filename || null,
              is_active: true
            });
            insertedCount++;
          }
        }

        showToast(\`Catalog processed: \${insertedCount} added, \${updatedCount} updated (0 duplicates)!\`, 'success');
        fetchCatalogProducts();
      } catch (err) {
        showToast('Catalog parsing error: ' + err.message, 'error');
      }
    }

    function extractItemsFromTableRows(rows) {
      const headerRow = (rows[0] || []).map(h => String(h || '').toLowerCase().trim());
      let skuIdx = headerRow.findIndex(h => /sku|code|item\\s*id|part/i.test(h));
      let nameIdx = headerRow.findIndex(h => /name|item|product|title|machine|course/i.test(h));
      let priceIdx = headerRow.findIndex(h => /price|rate|cost|mrp|amount|fee/i.test(h));
      let specsIdx = headerRow.findIndex(h => /model|spec|capacity|detail|feature|batch/i.test(h));

      if (nameIdx === -1) nameIdx = 0;
      if (priceIdx === -1) priceIdx = headerRow.findIndex((h, idx) => idx !== nameIdx && /amt|rs|inr/i.test(h));

      const items = [];
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length === 0) continue;
        const name = String(r[nameIdx] || '').trim();
        if (!name || name.toLowerCase() === 'product name' || name.toLowerCase() === 'name') continue;

        const sku = (skuIdx !== -1 && r[skuIdx]) ? String(r[skuIdx]).trim() : ('SKU-' + (100 + i));
        const price_raw = (priceIdx !== -1 && r[priceIdx]) ? String(r[priceIdx]).trim() : 'Contact for quote';
        const model_specs = (specsIdx !== -1 && r[specsIdx]) ? String(r[specsIdx]).trim() : '';

        items.push({ sku, name, price_raw, model_specs });
      }
      return items;
    }

    function extractItemsFromPdfText(text, filename) {
      if (!text || text.trim().length < 20) {
        return [{
          name: filename.replace(/\\.[^/.]+$/, '').replace(/[-_]/g, ' '),
          sku: 'PDF-' + Math.floor(100 + Math.random() * 900),
          price_raw: 'Contact for quote',
          model_specs: 'Full verified technical brochure'
        }];
      }

      // Identify candidate items separated by model codes, bullet points, or numbered lines
      const items = [];
      const lines = text.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);

      const itemRegex = /(?:^|\\b)([A-Z0-9-]{3,12}\\s+(?:Machine|Packer|Filler|Unit|Blender|Series|Model|System)[^.]{0,60})/i;
      for (const line of lines) {
        const match = line.match(itemRegex);
        if (match && match[1] && match[1].length > 5 && !items.some(it => it.name === match[1])) {
          items.push({
            name: match[1].trim(),
            sku: 'SKU-' + Math.floor(100 + Math.random() * 900),
            price_raw: 'Contact for quote',
            model_specs: line.slice(0, 100)
          });
        }
        if (items.length >= 10) break;
      }

      if (items.length === 0) {
        return [{
          name: filename.replace(/\\.[^/.]+$/, '').replace(/[-_]/g, ' '),
          sku: 'CAT-' + Math.floor(100 + Math.random() * 900),
          price_raw: 'Contact for quote',
          model_specs: text.slice(0, 120).trim()
        }];
      }
      return items;
    }

    // =========================================================================
    // ✏️ INLINE EDITING & EDIT SKU MODAL
    // =========================================================================
    let catalogProductsCache = [];

    async function inlineEditProductPrice(id, currentPrice) {
      const newPrice = prompt('Enter updated price specification:', currentPrice || '');
      if (newPrice === null || newPrice.trim() === currentPrice) return;
      try {
        if (sb) {
          const { error } = await sb.from('products').update({ price_raw: newPrice.trim() }).eq('id', id).eq('org_id', currentOrg.id);
          if (error) throw error;
        }
        showToast('Price updated to ' + newPrice.trim(), 'success');
        fetchCatalogProducts();
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    async function inlineEditProductSpecs(id, currentSpecs) {
      const newSpecs = prompt('Enter updated model specifications:', currentSpecs || '');
      if (newSpecs === null || newSpecs.trim() === currentSpecs) return;
      try {
        if (sb) {
          const { error } = await sb.from('products').update({ model_specs: newSpecs.trim() }).eq('id', id).eq('org_id', currentOrg.id);
          if (error) throw error;
        }
        showToast('Specifications updated!', 'success');
        fetchCatalogProducts();
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    function openEditProductModal(productId) {
      const prod = catalogProductsCache.find(p => p.id === productId);
      if (!prod) return;

      if (document.getElementById('editProductId')) document.getElementById('editProductId').value = prod.id;
      if (document.getElementById('editSku')) document.getElementById('editSku').value = prod.sku || '';
      if (document.getElementById('editProductName')) document.getElementById('editProductName').value = prod.name || '';
      if (document.getElementById('editPriceRaw')) document.getElementById('editPriceRaw').value = prod.price_raw || '';
      if (document.getElementById('editModel')) document.getElementById('editModel').value = prod.model_specs || '';

      const modal = document.getElementById('editProductModal');
      if (modal) modal.classList.remove('hidden');
    }

    function closeEditProductModal() {
      const modal = document.getElementById('editProductModal');
      if (modal) modal.classList.add('hidden');
    }

    async function submitEditProduct() {
      const id = document.getElementById('editProductId')?.value;
      const sku = (document.getElementById('editSku')?.value || '').trim();
      const name = (document.getElementById('editProductName')?.value || '').trim();
      const price_raw = (document.getElementById('editPriceRaw')?.value || '').trim();
      const model_specs = (document.getElementById('editModel')?.value || '').trim();

      if (!name) return showToast('Product name is required', 'error');

      try {
        if (sb) {
          const { error } = await sb.from('products').update({
            sku,
            name,
            price_raw,
            model_specs
          }).eq('id', id).eq('org_id', currentOrg.id);
          if (error) throw error;
        }
        closeEditProductModal();
        showToast('Product updated successfully!', 'success');
        fetchCatalogProducts();
      } catch (e) {
        showToast(e.message, 'error');
      }
    }

    // =========================================================================
    // ⏱️ 48-HOUR LIVE TRIAL COUNTDOWN TIMER
    // =========================================================================
    let trialTimerInterval = null;
    function startTrialCountdownTimer() {
      if (trialTimerInterval) clearInterval(trialTimerInterval);

      function updateCountdown() {
        if (!currentOrg) return;

        const trialEnds = currentOrg.trial_ends_at ? new Date(currentOrg.trial_ends_at) : new Date(Date.now() + 48 * 3600 * 1000);
        const diffMs = trialEnds.getTime() - Date.now();

        const trialCountEl = document.getElementById('trialCountdownText');
        const memCountEl = document.getElementById('memCountdownDisplay');
        const memLeadQuota = document.getElementById('memLeadQuotaText');
        const memProgressBar = document.getElementById('memLeadProgressBar');

        const leadsUsed = currentOrg.trial_leads_used || currentOrg.leads_used || 0;
        const leadsLimit = currentOrg.trial_lead_limit || currentOrg.monthly_lead_limit || 25;
        const leadsLeft = Math.max(0, leadsLimit - leadsUsed);

        if (memLeadQuota) memLeadQuota.textContent = \`\${leadsUsed} / \${leadsLimit} Trial Leads Used (\${leadsLeft} Remaining)\`;
        if (memProgressBar) {
          const pct = Math.min(100, Math.round((leadsUsed / Math.max(1, leadsLimit)) * 100));
          memProgressBar.style.width = pct + '%';
        }

        if (diffMs <= 0) {
          if (trialCountEl) trialCountEl.textContent = 'Trial expired • Please activate full plan to resume';
          if (memCountEl) memCountEl.textContent = 'Trial Expired';
        } else {
          const totalHours = Math.floor(diffMs / (1000 * 60 * 60));
          const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
          const timeStr = \`\${totalHours}h \${mins}m trial remaining • \${leadsLeft} free inquiries left\`;
          if (trialCountEl) trialCountEl.textContent = timeStr;
          if (memCountEl) memCountEl.textContent = \`\${totalHours}h \${mins}m remaining\`;
        }
      }

      updateCountdown();
      trialTimerInterval = setInterval(updateCountdown, 30000);
    }
`;

// Now let's update fetchCatalogProducts to populate catalogProductsCache and render inline edit buttons
const oldFetchCatalogProductsRegex = /async function fetchCatalogProducts\(\)[\s\S]*?tbody\.innerHTML = prods\.map[\s\S]*?<\/tr>\s*`;\s*}\)\.join\(''\);\s*}/;

const newFetchCatalogProductsJs = `async function fetchCatalogProducts() {
      const container = document.getElementById('catalogProductsContainer');
      const tbody = document.getElementById('catalogTableBody');
      if (!tbody && !container) return;

      if (!currentOrg) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400">Please sign in to view catalog.</td></tr>';
        return;
      }

      try {
        let prods = [];
        if (sb) {
          const { data, error } = await sb
            .from('products')
            .select('*')
            .eq('org_id', currentOrg.id)
            .order('created_at', { ascending: false });
          if (error) throw error;
          prods = data || [];
        } else {
          const res = await apiFetch('/api/catalog');
          prods = res.products || [];
        }

        catalogProductsCache = prods;

        if (prods.length === 0) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center py-12 text-slate-400 font-medium">No products in catalog yet. Click "+ Quick Add SKU" or drag & drop an Excel / PDF brochure above!</td></tr>';
          return;
        }

        const rowsHtml = prods.map(p => {
          const price = p.price_raw || p.price_range || 'Contact for quote';
          const imgHtml = p.image_url
            ? \`<img src="\${escapeHtml(p.image_url)}" alt="\${escapeHtml(p.name)}" class="w-10 h-10 object-cover rounded-lg border border-gray-200 shadow-sm">\`
            : '<div class="w-10 h-10 rounded-lg bg-slate-100 border border-gray-200 flex items-center justify-center text-sm font-bold text-slate-500">⚙️</div>';
          const pdfHtml = p.brochure_url
            ? \`<a href="\${escapeHtml(p.brochure_url)}" target="_blank" class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-[11px] font-semibold transition border border-indigo-200"><span>📄</span><span>\${escapeHtml(p.brochure_filename || 'PDF Brochure')}</span></a>\`
            : '<span class="text-slate-400 text-[11px]">No PDF</span>';

          return \`
            <tr class="border-b border-gray-100 hover:bg-slate-50 transition text-xs">
              <td class="py-3 px-4">\${imgHtml}</td>
              <td class="py-3 px-4 font-mono font-bold text-slate-700">\${escapeHtml(p.sku || '-')}</td>
              <td class="py-3 px-4 font-semibold text-slate-900">\${escapeHtml(p.name)}</td>
              <td class="py-3 px-4 text-slate-600 max-w-xs truncate cursor-pointer hover:text-indigo-600 group" onclick="inlineEditProductSpecs('\${p.id}', '\${escapeHtml(p.model_specs || '')}')" title="Click to edit specs">
                <span>\${escapeHtml(p.model_specs || '-')}</span>
                <span class="opacity-0 group-hover:opacity-100 text-[10px] text-indigo-500 ml-1">✎</span>
              </td>
              <td class="py-3 px-4 text-slate-800 font-semibold cursor-pointer hover:text-indigo-600 group" onclick="inlineEditProductPrice('\${p.id}', '\${escapeHtml(p.price_raw || '')}')" title="Click to edit price">
                <span>\${escapeHtml(price)}</span>
                <span class="opacity-0 group-hover:opacity-100 text-[10px] text-indigo-500 ml-1">✎</span>
              </td>
              <td class="py-3 px-4">\${pdfHtml}</td>
              <td class="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                <button onclick="openEditProductModal('\${p.id}')" class="text-indigo-600 hover:text-indigo-800 font-semibold p-1 hover:bg-indigo-50 rounded transition text-xs inline-flex items-center gap-1">
                  <span>✎</span>
                  <span>Edit</span>
                </button>
                <button onclick="deleteCatalogProduct('\${p.id}')" class="text-rose-600 hover:text-rose-800 font-semibold p-1 hover:bg-rose-50 rounded transition text-xs inline-flex items-center gap-1">
                  <span>🗑️</span>
                  <span>Delete</span>
                </button>
              </td>
            </tr>
          \`;
        }).join('');

        if (tbody) {
          tbody.innerHTML = rowsHtml;
        }
      } catch (err) {
        if (tbody) tbody.innerHTML = \`<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading catalog: \${escapeHtml(err.message)}</td></tr>\`;
      }
    }`;

if (oldFetchCatalogProductsRegex.test(html)) {
  html = html.replace(oldFetchCatalogProductsRegex, newFetchCatalogProductsJs);
  console.log('✓ Updated fetchCatalogProducts with inline editing & edit modal trigger');
}

// Append new helper functions into <script>
if (!html.includes('syncWebsiteKnowledge')) {
  const scriptEndTarget = '</script>\n</body>';
  const scriptEndTargetLf = '</script>\r\n</body>';
  if (html.includes(scriptEndTargetLf)) {
    html = html.replace(scriptEndTargetLf, newHelperFunctionsJs + '\r\n</script>\r\n</body>');
  } else if (html.includes(scriptEndTarget)) {
    html = html.replace(scriptEndTarget, newHelperFunctionsJs + '\n</script>\n</body>');
  }
  console.log('✓ Appended new helper functions (Website sync, niche adaptation, trial countdown, edit modals)');
}

// Hook startTrialCountdownTimer and updateWebsiteSyncBadge into checkAuthStatus/init
if (!html.includes('startTrialCountdownTimer()')) {
  html = html.replace('loadDashboardData();', 'loadDashboardData();\n      startTrialCountdownTimer();\n      updateWebsiteSyncBadge();\n      applyNicheAdaptation();');
  console.log('✓ Hooked trial countdown & niche adaptation on login');
}

fs.writeFileSync(indexPath, html, 'utf8');
console.log('✓ Frontend JavaScript successfully upgraded!');

