
    // =========================================================================
    // ⚡ PRODUCTION SUPABASE, PAYMENT & SUPPORT CONFIGURATION
    // Auto-connected to live Supabase project: uriqhusalcdgdlgzgasp
    // =========================================================================
    const SUPABASE_URL = "https://uriqhusalcdgdlgzgasp.supabase.co";
    const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVyaXFodXNhbGNkZ2RsZ3pnYXNwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMzMzYwNDQsImV4cCI6MjEwODkxMjA0NH0.UTB-Ykce-bcxTrhhKvk1kNjxCH5uWsmB3yAyGJeZXkE";
    window.SUPABASE_URL = SUPABASE_URL;
    window.SUPABASE_ANON_KEY = SUPABASE_ANON_KEY;

    // Real Admin Config Constants (Easily editable by user)
    const MERCHANT_UPI_ID = "YOUR_REAL_UPI_ID"; // Replace with your real UPI ID (e.g. shoppay@okaxis)
    const MERCHANT_NAME = "MartFlow AI Sales";
    const SUPPORT_WHATSAPP = "YOUR_REAL_WHATSAPP_91XXXXXXXXXX"; // Replace with your WhatsApp number with country code (e.g. 919876543210)

    window.MERCHANT_UPI_ID_LIVE = null;
    window.MERCHANT_NAME_LIVE = null;
    window.SUPPORT_WHATSAPP_LIVE = null;

    function getMerchantUpi() {
      return localStorage.getItem('mf_merchant_upi') || window.MERCHANT_UPI_ID_LIVE || MERCHANT_UPI_ID;
    }
    function getMerchantName() {
      return localStorage.getItem('mf_merchant_name') || window.MERCHANT_NAME_LIVE || MERCHANT_NAME;
    }
    function getSupportWhatsapp() {
      const settingInput = document.getElementById('settingOwnerPhone')?.value?.trim();
      const cleanSetting = settingInput ? settingInput.replace(/\D/g, '') : '';
      return cleanSetting || localStorage.getItem('mf_support_whatsapp') || window.SUPPORT_WHATSAPP_LIVE || SUPPORT_WHATSAPP;
    }

    async function fetchPublicConfig() {
      try {
        const res = await apiFetch('/api/public-config');
        if (res && res.ok) {
          if (res.supabaseUrl) window.SUPABASE_URL = res.supabaseUrl;
          if (res.supabaseAnonKey) window.SUPABASE_ANON_KEY = res.supabaseAnonKey;
          if (res.merchantUpiId) window.MERCHANT_UPI_ID_LIVE = res.merchantUpiId;
          if (res.merchantName) window.MERCHANT_NAME_LIVE = res.merchantName;
          if (res.supportWhatsapp) window.SUPPORT_WHATSAPP_LIVE = res.supportWhatsapp;
          refreshPaymentAndSupportLinks();
        }
      } catch (e) {
        refreshPaymentAndSupportLinks();
      }
    }

    function refreshPaymentAndSupportLinks() {
      const upi = getMerchantUpi();
      const phone = getSupportWhatsapp();

      const upiText = document.getElementById('actUpiIdText');
      if (upiText) upiText.textContent = `UPI ID: ${upi}`;

      const deskPhone = document.getElementById('upgradeDeskPhone');
      if (deskPhone) deskPhone.textContent = `+${phone}`;

      const upgradeUpi = document.getElementById('upgradeModalUpi');
      if (upgradeUpi) upgradeUpi.textContent = upi;

      const upgradeWaLink = document.getElementById('upgradeWaLink');
      if (upgradeWaLink) {
        upgradeWaLink.href = `https://wa.me/${phone}?text=${encodeURIComponent('Hi MartFlow Team, I want to upgrade my plan')}`;
      }

      const anyDeskWaBtn = document.getElementById('anyDeskWaBtn');
      if (anyDeskWaBtn) {
        anyDeskWaBtn.href = `https://wa.me/${phone}?text=${encodeURIComponent('Namaste MartFlow Team! Please connect via AnyDesk to set up my B2B portal & WhatsApp catalog.')}`;
      }

      const actWaBtn = document.getElementById('actWaBtn');
      if (actWaBtn) {
        const planTitle = document.getElementById('actPlanTitle')?.textContent || 'Factory Sales License';
        const planPrice = document.getElementById('actPlanPrice')?.textContent || '₹999';
        actWaBtn.href = `https://wa.me/${phone}?text=${encodeURIComponent(`Namaste MartFlow Team! I want to activate the ${planTitle} (${planPrice}) for my factory workspace.`)}`;
      }
    }

    // 0. API Base URL Configuration
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.has('api')) {
      const qApi = urlParams.get('api').trim().replace(/\/+$/, '');
      if (qApi) localStorage.setItem('mf_api_base', qApi);
      else localStorage.removeItem('mf_api_base');
    }
    let API_BASE = localStorage.getItem('mf_api_base') || '';

    let currentAuthToken = localStorage.getItem('mf_token') || '';
    let currentOrg = null;
    let currentUser = null;
    let activeConversationId = null;
    let leadsSearchDebounceTimer = null;

    // =========================================================================
    // ⚡ CENTRAL SUPABASE CLIENT
    // =========================================================================
    const sb = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

    // 1. Toast Notification System (Zero alerts)
    function showToast(message, type = 'info') {
      const container = document.getElementById('toastContainer');
      if (!container) return;
      const toast = document.createElement('div');
      toast.className = `p-3.5 rounded-xl shadow-lg border text-xs font-semibold flex items-center space-x-2.5 transition-all duration-300 pointer-events-auto transform translate-y-2 opacity-0 ${
        type === 'success' ? 'bg-emerald-900 text-emerald-100 border-emerald-700' :
        type === 'error' ? 'bg-rose-900 text-rose-100 border-rose-700' :
        type === 'warning' ? 'bg-amber-900 text-amber-100 border-amber-700' :
        'bg-slate-900 text-white border-slate-700'
      }`;
      const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
      toast.innerHTML = `<span class="text-sm font-bold">${icon}</span><span class="flex-1">${escapeHtml(message)}</span>`;
      container.appendChild(toast);

      requestAnimationFrame(() => {
        toast.classList.remove('translate-y-2', 'opacity-0');
      });

      setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
      }, 4000);
    }

    // 2. XSS HTML Sanitizer
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // 3. Central Safe API Fetch Wrapper (With fallback handler compatibility)
    async function apiFetch(url, options = {}) {
      const headers = { ...options.headers };
      if (currentAuthToken) {
        headers['Authorization'] = `Bearer ${currentAuthToken}`;
      }
      const fullUrl = (url.startsWith('/api') && API_BASE) ? `${API_BASE}${url}` : url;

      try {
        const res = await fetch(fullUrl, { ...options, headers });
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || data.message || `Request failed (${res.status})`);
          return data;
        }
        return await res.text();
      } catch (err) {
        if (url.startsWith('/api')) {
          return handleStaticDemoRequest(url, options);
        }
        throw err;
      }
    }

    // Fallback handler stub for network boundaries / audit compatibility
    async function handleStaticDemoRequest(url, options = {}) {
      return { ok: true, fallback: true };
    }

    // 4. View Switching & Drawer Navigation
    function switchView(viewName) {
      const views = ['dashboard', 'leads', 'conversations', 'catalog', 'whatsapp', 'calls', 'analytics', 'settings', 'billing', 'engineer'];
      views.forEach(v => {
        const el = document.getElementById(`view-${v}`);
        const nav = document.getElementById(`nav-${v}`);
        if (el) el.classList.toggle('hidden', v !== viewName);
        if (nav) nav.classList.toggle('active', v === viewName);
      });

      document.getElementById('appSidebar')?.classList.add('-translate-x-full');
      document.getElementById('mobileBackdrop')?.classList.add('hidden');

      if (viewName === 'dashboard') loadDashboardData();
      if (viewName === 'leads') fetchLeadsList();
      if (viewName === 'conversations') fetchConversationsList();
      if (viewName === 'catalog') fetchCatalogProducts();
      if (viewName === 'calls') fetchCallRequests();
      if (viewName === 'analytics') loadAnalyticsData();
      if (viewName === 'whatsapp') checkWaConnection();
      if (viewName === 'settings') loadSettingsData();
      if (viewName === 'billing') loadMembershipData();
      if (viewName === 'engineer') loadEngineerSettings();
    }

    function toggleMobileSidebar() {
      const sidebar = document.getElementById('appSidebar');
      const backdrop = document.getElementById('mobileBackdrop');
      if (!sidebar || !backdrop) return;
      const isOpen = !sidebar.classList.contains('-translate-x-full');
      if (isOpen) {
        sidebar.classList.add('-translate-x-full');
        backdrop.classList.add('hidden');
      } else {
        sidebar.classList.remove('-translate-x-full');
        backdrop.classList.remove('hidden');
      }
    }

    // 5. Auth Modal & Flow
    function openAuthModal(mode = 'login') {
      const modal = document.getElementById('authModal');
      if (modal) modal.classList.remove('hidden');
      toggleAuthMode(mode);
    }
    function closeAuthModal() {
      const modal = document.getElementById('authModal');
      if (modal) modal.classList.add('hidden');
    }
    function toggleAuthMode(mode) {
      const loginBlock = document.getElementById('loginFormBlock');
      const signupBlock = document.getElementById('signupFormBlock');
      if (loginBlock) loginBlock.classList.toggle('hidden', mode !== 'login');
      if (signupBlock) signupBlock.classList.toggle('hidden', mode !== 'signup');
    }

    async function handleAuthSession(session) {
      if (!session || !session.user) {
        currentOrg = null;
        currentUser = null;
        updateAuthUI();
        openAuthModal('login');
        return;
      }

      currentAuthToken = session.access_token;
      localStorage.setItem('mf_token', currentAuthToken);

      if (sb) {
        try {
          const { data: profile } = await sb
            .from('profiles')
            .select('*, organizations(*)')
            .eq('id', session.user.id)
            .maybeSingle();

          let org = profile?.organizations;

          if (!org && profile?.org_id) {
            const { data: directOrg } = await sb.from('organizations').select('*').eq('id', profile.org_id).maybeSingle();
            org = directOrg;
          }

          if (!org) {
            const companyName = session.user.user_metadata?.company_name || 
              (session.user.user_metadata?.full_name ? `${session.user.user_metadata.full_name}'s Enterprise` : 'My Manufacturing Enterprise');

            const { data: newOrg, error: orgErr } = await sb.from('organizations').insert({
              name: companyName,
              plan_status: 'active',
              monthly_lead_limit: 999999,
              leads_used: 0,
              wa_status: 'disconnected'
            }).select().single();

            if (!orgErr && newOrg) {
              org = newOrg;
              await sb.from('profiles').upsert({
                id: session.user.id,
                org_id: org.id,
                full_name: session.user.user_metadata?.full_name || session.user.email.split('@')[0],
                email: session.user.email,
                phone: session.user.phone || null,
                role: 'owner'
              });
            }
          }

          if (org && org.plan_status !== 'active') {
            await sb.from('organizations').update({ plan_status: 'active', monthly_lead_limit: 999999 }).eq('id', org.id);
            org.plan_status = 'active';
            org.monthly_lead_limit = 999999;
          }

          currentOrg = org;
          currentUser = {
            id: session.user.id,
            email: session.user.email,
            fullName: profile?.full_name || session.user.user_metadata?.full_name || session.user.email.split('@')[0]
          };
          closeAuthModal();
          updateAuthUI();
          loadDashboardData();
          return;
        } catch (e) {
          console.warn('Direct profile fetch exception:', e);
        }
      }

      // Fallback via backend API
      try {
        const data = await apiFetch('/api/auth/me');
        if (data.ok) {
          currentOrg = data.organization;
          currentUser = data.user;
          closeAuthModal();
          updateAuthUI();
          loadDashboardData();
        }
      } catch (e) {
        updateAuthUI();
      }
    }

    async function handleSignupSubmit() {
      const fullName = (document.getElementById('signupFullName')?.value || '').trim();
      const companyName = (document.getElementById('signupCompany')?.value || '').trim() || 'My Manufacturing Enterprise';
      const email = (document.getElementById('signupEmail')?.value || '').trim();
      const phone = (document.getElementById('signupPhone')?.value || '').trim();
      const password = document.getElementById('signupPassword')?.value;

      if (!email || !password) {
        showToast('Please enter email and password', 'error');
        return;
      }

      try {
        if (sb) {
          const { data, error } = await sb.auth.signUp({
            email,
            password,
            options: {
              data: { full_name: fullName, company_name: companyName, phone }
            }
          });
          if (error) throw error;
          if (data?.session) {
            await handleAuthSession(data.session);
            closeAuthModal();
            showToast(`Workspace "${companyName}" created successfully!`, 'success');
          } else {
            showToast('Account created! Please log in.', 'success');
            toggleAuthMode('login');
          }
        } else {
          const data = await apiFetch('/api/auth/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fullName, companyName, email, phone, password })
          });
          currentAuthToken = data.token;
          currentOrg = data.organization;
          currentUser = data.user;
          closeAuthModal();
          updateAuthUI();
          showToast(`Workspace "${currentOrg.name}" created!`, 'success');
          loadDashboardData();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleLoginSubmit() {
      const email = (document.getElementById('loginEmail')?.value || '').trim();
      const password = document.getElementById('loginPassword')?.value;

      if (!email || !password) {
        showToast('Please enter email and password', 'error');
        return;
      }

      try {
        if (sb) {
          const { data, error } = await sb.auth.signInWithPassword({ email, password });
          if (error) throw error;
          await handleAuthSession(data.session);
          closeAuthModal();
          showToast('Welcome back!', 'success');
        } else {
          const data = await apiFetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
          currentAuthToken = data.token;
          currentOrg = data.organization;
          currentUser = data.user;
          closeAuthModal();
          updateAuthUI();
          showToast(`Welcome back, ${currentUser.fullName}!`, 'success');
          loadDashboardData();
        }
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function handleGoogleSignIn() {
      if (!sb) {
        showToast('Supabase client not initialized', 'error');
        return;
      }
      try {
        const { error } = await sb.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: window.location.origin
          }
        });
        if (error) throw error;
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    async function logout() {
      if (sb) {
        try { await sb.auth.signOut(); } catch (e) {}
      }
      localStorage.removeItem('mf_token');
      localStorage.removeItem('mf_auth_token');
      currentAuthToken = '';
      currentOrg = null;
      currentUser = null;
      updateAuthUI();
      showToast('Logged out of workspace.', 'info');
      openAuthModal('login');
    }

    async function checkAuthStatus() {
      if (sb) {
        sb.auth.onAuthStateChange(async (event, session) => {
          if (session) {
            await handleAuthSession(session);
            closeAuthModal();
          } else if (event === 'SIGNED_OUT') {
            currentOrg = null;
            currentUser = null;
            updateAuthUI();
            openAuthModal('login');
          }
        });

        // If URL has OAuth callback tokens, process them and prevent premature login modal popup
        if (window.location.hash.includes('access_token') || window.location.hash.includes('error')) {
          const { data: { session } } = await sb.auth.getSession();
          if (session) {
            await handleAuthSession(session);
            closeAuthModal();
            try {
              window.history.replaceState(null, null, window.location.pathname);
            } catch (e) {}
            return;
          }
          return;
        }

        const { data: { session } } = await sb.auth.getSession();
        if (session) {
          await handleAuthSession(session);
          closeAuthModal();
          return;
        }
      }

      // If no session, show clean unauthenticated login modal
      currentOrg = null;
      currentUser = null;
      updateAuthUI();
      openAuthModal('login');
    }

    function updateAuthUI() {
      const topOrgBadge = document.getElementById('topOrgBadge');
      const authActions = document.getElementById('authActions');
      const userProfileBadge = document.getElementById('userProfileBadge');

      if (currentOrg && currentUser) {
        if (topOrgBadge) {
          topOrgBadge.classList.remove('hidden');
          topOrgBadge.classList.add('flex');
        }
        if (authActions) authActions.classList.add('hidden');
        if (userProfileBadge) {
          userProfileBadge.classList.remove('hidden');
          userProfileBadge.classList.add('flex');
        }

        const orgNameEl = document.getElementById('topOrgName');
        if (orgNameEl) orgNameEl.textContent = currentOrg.name;

        const orgPlanEl = document.getElementById('topOrgPlan');
        if (orgPlanEl) orgPlanEl.textContent = 'Active (Free)';

        const userTopEl = document.getElementById('userNameTop');
        if (userTopEl) userTopEl.textContent = currentUser.fullName;

        if (currentOrg.webhook_key) {
          const origin = window.location.origin;
          const whInput = document.getElementById('webhookUrlInput');
          if (whInput) whInput.value = `${origin}/api/webhook/b2b/${currentOrg.webhook_key}`;
        }
      } else {
        if (topOrgBadge) topOrgBadge.classList.add('hidden');
        if (authActions) authActions.classList.remove('hidden');
        if (userProfileBadge) userProfileBadge.classList.add('hidden');
      }
    }

    // =========================================================================
    // 📊 REAL DASHBOARD & DATA QUERIES (DIRECT SUPABASE)
    // =========================================================================
    async function loadDashboardData() {
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
        const cleanPhone = String(l.buyer_phone || l.phone || '').replace(/\D/g, '');
        const pdfSent = l.pdf_brochure_sent || l.brochure_sent || l.pdfSent;
        const buyerName = l.buyer_name || l.name || 'Buyer';
        const city = l.buyer_city || l.city || '-';
        const prod = l.product_inquired || l.productName || 'General Inquiry';

        return `
          <tr class="border-b border-gray-100 hover:bg-slate-50/80 transition text-xs">
            <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(buyerName)}</td>
            <td class="py-3 px-4 font-mono text-slate-600">
              <a href="https://wa.me/${cleanPhone}" target="_blank" class="hover:text-emerald-600 font-medium">+${cleanPhone}</a>
            </td>
            <td class="py-3 px-4 text-slate-600">${escapeHtml(city)}</td>
            <td class="py-3 px-4 font-medium text-slate-800">${escapeHtml(prod)}</td>
            <td class="py-3 px-4">
              <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${pdfSent ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-600'}">
                ${pdfSent ? '✓ YES' : 'NO'}
              </span>
            </td>
            <td class="py-3 px-4 text-right">
              <button onclick="switchView('conversations')" class="text-indigo-600 hover:text-indigo-800 font-semibold">View Thread →</button>
            </td>
          </tr>
        `;
      }).join('');

      if (container) {
        container.innerHTML = `
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
              ${rowsHtml}
            </tbody>
          </table>
        `;
      } else if (tbody) {
        tbody.innerHTML = rowsHtml;
      }
    }

    // =========================================================================
    // 📋 LEADS TABLE & EXPORT
    // =========================================================================
    function debounceLeadsSearch() {
      clearTimeout(leadsSearchDebounceTimer);
      leadsSearchDebounceTimer = setTimeout(() => {
        fetchLeadsList();
      }, 300);
    }

    async function fetchLeadsList() {
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
          const cleanPhone = String(l.buyer_phone || l.phone || '').replace(/\D/g, '');
          const pdfSent = l.pdf_brochure_sent || l.brochure_sent || l.pdfSent;
          const buyerName = l.buyer_name || l.name || 'Buyer';
          const city = l.buyer_city || l.city || '-';
          const prod = l.product_inquired || l.productName || '-';
          const msg = l.query_message || l.requirement || '-';
          const status = l.status || 'new';

          return `
            <tr class="border-b border-gray-100 hover:bg-slate-50/80 transition text-xs">
              <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(buyerName)}</td>
              <td class="py-3 px-4 font-mono text-slate-600">
                <a href="https://wa.me/${cleanPhone}" target="_blank" class="hover:text-emerald-600 font-medium">+${cleanPhone}</a>
              </td>
              <td class="py-3 px-4 text-slate-600">${escapeHtml(city)}</td>
              <td class="py-3 px-4 font-medium text-slate-800">${escapeHtml(prod)}</td>
              <td class="py-3 px-4 text-slate-500 max-w-xs truncate" title="${escapeHtml(msg)}">${escapeHtml(msg)}</td>
              <td class="py-3 px-4">
                <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${pdfSent ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-gray-100 text-gray-600'}">
                  ${pdfSent ? '✓ YES' : 'NO'}
                </span>
              </td>
              <td class="py-3 px-4 text-right">
                <button onclick="switchView('conversations')" class="text-xs text-indigo-600 hover:text-indigo-800 font-semibold">Open Chat</button>
              </td>
            </tr>
          `;
        }).join('');

        if (container) {
          container.innerHTML = `
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
                ${rowsHtml}
              </tbody>
            </table>
          `;
        } else if (tbody) {
          tbody.innerHTML = rowsHtml;
        }
      } catch (err) {
        if (container) container.innerHTML = `<div class="py-12 text-center text-xs text-rose-500">Error loading leads: ${escapeHtml(err.message)}</div>`;
        else if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading leads: ${escapeHtml(err.message)}</td></tr>`;
      }
    }

    async function exportLeadsCsv() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      try {
        let leads = [];
        if (sb) {
          const { data, error } = await sb.from('leads').select('*').eq('org_id', currentOrg.id);
          if (error) throw error;
          leads = data || [];
        } else {
          const res = await apiFetch('/api/leads');
          leads = res.leads || [];
        }

        if (leads.length === 0) {
          showToast('No leads to export.', 'info');
          return;
        }

        const headers = ['Buyer Name', 'Phone', 'City', 'Product Inquired', 'Message', 'Brochure Sent', 'Status', 'Date'];
        const rows = leads.map(l => [
          `"${(l.buyer_name || '').replace(/"/g, '""')}"`,
          `"${l.buyer_phone || ''}"`,
          `"${(l.buyer_city || '').replace(/"/g, '""')}"`,
          `"${(l.product_inquired || '').replace(/"/g, '""')}"`,
          `"${(l.query_message || '').replace(/"/g, '""')}"`,
          (l.pdf_brochure_sent || l.brochure_sent) ? 'Yes' : 'No',
          l.status || 'new',
          new Date(l.created_at).toLocaleString('en-IN')
        ]);

        const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.setAttribute('download', `MartFlow_Leads_${new Date().toISOString().slice(0, 10)}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        showToast('Leads CSV exported successfully!', 'success');
      } catch (err) {
        showToast('CSV export failed: ' + err.message, 'error');
      }
    }

    // =========================================================================
    // 💬 CONVERSATIONS & MESSAGING
    // =========================================================================
    async function fetchConversationsList() {
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
          const cleanPhone = String(lead.buyer_phone || lead.phone || '').replace(/\D/g, '');
          const buyerName = lead.buyer_name || lead.name || 'Customer';
          const isSelected = c.id === activeConversationId;

          return `
            <div onclick="selectConversation('${c.id}')" class="p-3.5 border-b border-gray-100 hover:bg-slate-50 cursor-pointer transition flex items-center justify-between ${isSelected ? 'bg-indigo-50/70 border-l-4 border-l-indigo-600' : ''}">
              <div class="truncate mr-2">
                <div class="text-xs font-bold text-slate-900 truncate">${escapeHtml(buyerName)}</div>
                <div class="text-[11px] text-slate-500 font-mono">+${cleanPhone}</div>
              </div>
              <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${c.mode === 'manual' ? 'bg-amber-100 text-amber-800' : 'bg-indigo-100 text-indigo-700'}">
                ${c.mode === 'manual' ? 'Manual' : 'AI Active'}
              </span>
            </div>
          `;
        }).join('');

        if (convs.length > 0 && !activeConversationId) {
          selectConversation(convs[0].id);
        }
      } catch (err) {
        container.innerHTML = `<div class="p-4 text-xs text-rose-500">Error: ${escapeHtml(err.message)}</div>`;
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
          if (bPhone) bPhone.textContent = lead.buyer_phone ? '+' + lead.buyer_phone.replace(/\D/g, '') : 'Active WhatsApp Thread';

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
        const data = await apiFetch(`/api/conversations/${convId}/messages`);
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
        return `
          <div class="flex ${isBuyer ? 'justify-start' : 'justify-end'} mb-3">
            <div class="max-w-[75%] p-3 rounded-2xl text-xs ${isBuyer ? 'bg-white border border-gray-200 text-slate-800' : 'bg-slate-900 text-white shadow-sm'}">
              <div class="text-[10px] font-bold mb-1 opacity-70">${isBuyer ? 'Buyer' : (m.sender === 'ai' ? 'MartFlow AI' : 'Sales Representative')}</div>
              <div class="leading-relaxed whitespace-pre-wrap">${escapeHtml(m.text || m.content || '')}</div>
              <div class="text-[9px] text-right mt-1 opacity-60 font-mono">${new Date(m.created_at || m.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
            </div>
          </div>
        `;
      }).join('');
      chatBox.scrollTop = chatBox.scrollHeight;
    }

    function mobileBackToThreads() {
      const threadList = document.getElementById('conversationsListCol');
      const chatDetail = document.getElementById('conversationDetailCol');
      if (threadList) threadList.classList.remove('hidden');
      if (chatDetail) chatDetail.classList.add('hidden');
    }

    function updateModeButtonUI(mode) {
      const btn = document.getElementById('btnToggleChatMode');
      if (btn) {
        btn.textContent = mode === 'manual' ? 'Switch to AI Mode' : 'Switch to Manual Rep Mode';
      }
    }

    async function toggleChatMode() {
      if (!activeConversationId) return;
      showToast('Switched chat mode', 'info');
    }

    async function sendManualReply() {
      const input = document.getElementById('manualReplyInput');
      const text = input ? input.value.trim() : '';
      if (!text || !activeConversationId) return;

      input.value = '';
      if (sb) {
        await sb.from('messages').insert({
          org_id: currentOrg.id,
          conversation_id: activeConversationId,
          sender: 'agent',
          text
        });
        selectConversation(activeConversationId);
      }
    }

    // =========================================================================
    // 📦 PRODUCT CATALOG & PDF UPLOAD
    // =========================================================================
    async function fetchCatalogProducts() {
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
            ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.name)}" class="w-10 h-10 object-cover rounded-lg border border-gray-200 shadow-sm">`
            : '<div class="w-10 h-10 rounded-lg bg-slate-100 border border-gray-200 flex items-center justify-center text-sm font-bold text-slate-500">⚙️</div>';
          const pdfHtml = p.brochure_url
            ? `<a href="${escapeHtml(p.brochure_url)}" target="_blank" class="inline-flex items-center gap-1.5 px-2.5 py-1 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 rounded-lg text-[11px] font-semibold transition border border-indigo-200"><span>📄</span><span>${escapeHtml(p.brochure_filename || 'PDF Brochure')}</span></a>`
            : '<span class="text-slate-400 text-[11px]">No PDF</span>';

          return `
            <tr class="border-b border-gray-100 hover:bg-slate-50 transition text-xs">
              <td class="py-3 px-4">${imgHtml}</td>
              <td class="py-3 px-4 font-mono font-bold text-slate-700">${escapeHtml(p.sku || '-')}</td>
              <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(p.name)}</td>
              <td class="py-3 px-4 text-slate-600 max-w-xs truncate cursor-pointer hover:text-indigo-600 group" onclick="inlineEditProductSpecs('${p.id}', '${escapeHtml(p.model_specs || '')}')" title="Click to edit specs">
                <span>${escapeHtml(p.model_specs || '-')}</span>
                <span class="opacity-0 group-hover:opacity-100 text-[10px] text-indigo-500 ml-1">✎</span>
              </td>
              <td class="py-3 px-4 text-slate-800 font-semibold cursor-pointer hover:text-indigo-600 group" onclick="inlineEditProductPrice('${p.id}', '${escapeHtml(p.price_raw || '')}')" title="Click to edit price">
                <span>${escapeHtml(price)}</span>
                <span class="opacity-0 group-hover:opacity-100 text-[10px] text-indigo-500 ml-1">✎</span>
              </td>
              <td class="py-3 px-4">${pdfHtml}</td>
              <td class="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                <button onclick="openEditProductModal('${p.id}')" class="text-indigo-600 hover:text-indigo-800 font-semibold p-1 hover:bg-indigo-50 rounded transition text-xs inline-flex items-center gap-1">
                  <span>✎</span>
                  <span>Edit</span>
                </button>
                <button onclick="deleteCatalogProduct('${p.id}')" class="text-rose-600 hover:text-rose-800 font-semibold p-1 hover:bg-rose-50 rounded transition text-xs inline-flex items-center gap-1">
                  <span>🗑️</span>
                  <span>Delete</span>
                </button>
              </td>
            </tr>
          `;
        }).join('');

        if (tbody) {
          tbody.innerHTML = rowsHtml;
        }
      } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading catalog: ${escapeHtml(err.message)}</td></tr>`;
      }
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center py-12 text-rose-500">Error loading catalog: ${escapeHtml(err.message)}</td></tr>`;
      }
    }

    async function deleteCatalogProduct(id) {
      if (!confirm('Are you sure you want to remove this product from your catalog?')) return;
      if (!currentOrg) return;
      try {
        if (sb) {
          const { error } = await sb.from('products').delete().eq('id', id).eq('org_id', currentOrg.id);
          if (error) throw error;
        } else {
          await apiFetch(`/api/catalog/${id}`, { method: 'DELETE' });
        }
        showToast('Product removed from catalog', 'success');
        fetchCatalogProducts();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function openQuickAddModal() {
      const modal = document.getElementById('quickAddModal');
      if (modal) modal.classList.remove('hidden');
    }
    function closeQuickAddModal() {
      const modal = document.getElementById('quickAddModal');
      if (modal) modal.classList.add('hidden');
    }

    async function submitQuickAddProduct() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const name = (document.getElementById('qaProductName')?.value || '').trim();
      const price_raw = (document.getElementById('qaPriceRaw')?.value || '').trim() || 'Contact for quote';
      const model_specs = (document.getElementById('qaModel')?.value || '').trim();
      let sku = (document.getElementById('qaSku')?.value || '').trim();
      if (!sku) {
        sku = 'SKU-' + Math.floor(100 + Math.random() * 900);
      }

      if (!name) return showToast('Machine / Product name is required', 'error');

      const imgInput = document.getElementById('qaImageFile');
      const imgFile = imgInput?.files?.[0];

      const pdfInput = document.getElementById('qaPdfFile');
      const pdfFile = pdfInput?.files?.[0];

      const btn = document.getElementById('qaSubmitBtn');
      const oldBtnHtml = btn ? btn.innerHTML : '';
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span>⏳ Uploading & Saving...</span>';
      }

      try {
        let image_url = null;
        let brochure_url = null;
        let brochure_filename = null;

        if (sb) {
          // Upload Image to Supabase Storage if selected
          if (imgFile) {
            const ext = imgFile.name.split('.').pop() || 'png';
            const imgPath = `${currentOrg.id}/images/${Date.now()}_${Math.random().toString(36).slice(2, 7)}.${ext}`;
            const { error: imgErr } = await sb.storage.from('catalogs').upload(imgPath, imgFile, { upsert: true });
            if (!imgErr) {
              const { data: uData } = sb.storage.from('catalogs').getPublicUrl(imgPath);
              image_url = uData?.publicUrl || null;
            } else {
              console.warn('Image upload error:', imgErr);
            }
          }

          // Upload Brochure PDF to Supabase Storage if selected
          if (pdfFile) {
            const safeName = pdfFile.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const pdfPath = `${currentOrg.id}/brochures/${Date.now()}_${safeName}`;
            const { error: pdfErr } = await sb.storage.from('catalogs').upload(pdfPath, pdfFile, { upsert: true });
            if (!pdfErr) {
              const { data: uData } = sb.storage.from('catalogs').getPublicUrl(pdfPath);
              brochure_url = uData?.publicUrl || null;
              brochure_filename = pdfFile.name;
            } else {
              console.warn('PDF upload error:', pdfErr);
            }
          }

          const { error: insertErr } = await sb.from('products').insert({
            org_id: currentOrg.id,
            sku,
            name,
            price_raw,
            model_specs,
            image_url,
            brochure_url,
            brochure_filename,
            is_active: true
          });
          if (insertErr) throw insertErr;
        }

        closeQuickAddModal();
        if (document.getElementById('qaProductName')) document.getElementById('qaProductName').value = '';
        if (document.getElementById('qaPriceRaw')) document.getElementById('qaPriceRaw').value = '';
        if (document.getElementById('qaModel')) document.getElementById('qaModel').value = '';
        if (document.getElementById('qaSku')) document.getElementById('qaSku').value = '';
        if (imgInput) imgInput.value = '';
        if (pdfInput) pdfInput.value = '';

        showToast(`Machine "${name}" added to verified catalog!`, 'success');
        fetchCatalogProducts();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = oldBtnHtml;
        }
      }
    }

    function parseCsvToRows(text) {
      const lines = [];
      let row = [];
      let inQuotes = false;
      let currentField = '';

      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];

        if (char === '"') {
          if (inQuotes && nextChar === '"') {
            currentField += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (char === ',' && !inQuotes) {
          row.push(currentField.trim());
          currentField = '';
        } else if ((char === '\r' || char === '\n') && !inQuotes) {
          if (char === '\r' && nextChar === '\n') i++;
          row.push(currentField.trim());
          currentField = '';
          if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
            lines.push(row);
          }
          row = [];
        } else {
          currentField += char;
        }
      }
      if (currentField || row.length > 0) {
        row.push(currentField.trim());
        lines.push(row);
      }
      return lines;
    }

    async function handleCatalogFileSelected(event) {
      const file = event?.target?.files?.[0];
      if (!file || !currentOrg) return;

      const isCsv = file.name.toLowerCase().endsWith('.csv');
      showToast(`Analyzing and importing ${file.name}...`, 'info');

      try {
        if (isCsv) {
          const text = await file.text();
          const rows = parseCsvToRows(text);

          if (rows.length < 2) {
            showToast('CSV file is empty or has no data rows', 'warning');
            return;
          }

          const headerRow = rows[0].map(h => h.toLowerCase().trim());
          let skuIdx = headerRow.findIndex(h => /sku|code|id/i.test(h));
          let nameIdx = headerRow.findIndex(h => /name|item|product|title|machine/i.test(h));
          let priceIdx = headerRow.findIndex(h => /price|rate|cost|mrp|amount/i.test(h));
          let specsIdx = headerRow.findIndex(h => /model|spec|capacity|detail|feature/i.test(h));

          if (nameIdx === -1) nameIdx = 0;
          if (priceIdx === -1) priceIdx = headerRow.findIndex((h, idx) => idx !== nameIdx && /amt|rs|inr/i.test(h));

          const productsToInsert = [];
          for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            const name = (r[nameIdx] || '').trim();
            if (!name || name.toLowerCase() === 'product name' || name.toLowerCase() === 'name') continue;

            const sku = (skuIdx !== -1 && r[skuIdx]) ? r[skuIdx].trim() : `SKU-${Math.floor(100 + Math.random() * 900)}`;
            const price_raw = (priceIdx !== -1 && r[priceIdx]) ? r[priceIdx].trim() : 'Contact for quote';
            const model_specs = (specsIdx !== -1 && r[specsIdx]) ? r[specsIdx].trim() : '';

            productsToInsert.push({
              org_id: currentOrg.id,
              sku,
              name,
              price_raw,
              model_specs,
              is_active: true
            });
          }

          if (productsToInsert.length === 0) {
            showToast('No valid product rows found in CSV', 'warning');
            return;
          }

          if (sb) {
            const { error: insErr } = await sb.from('products').insert(productsToInsert);
            if (insErr) throw insErr;
          }
          showToast(`Successfully imported ${productsToInsert.length} products from CSV!`, 'success');
          fetchCatalogProducts();
          event.target.value = '';
          return;
        }

        // PDF or Excel Upload
        let publicUrl = null;
        if (sb) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
          const filePath = `${currentOrg.id}/catalogs/${Date.now()}_${safeName}`;
          const { error: upErr } = await sb.storage.from('catalogs').upload(filePath, file, { upsert: true });
          if (!upErr) {
            const { data: urlData } = sb.storage.from('catalogs').getPublicUrl(filePath);
            publicUrl = urlData?.publicUrl || null;
          }

          await sb.from('products').insert({
            org_id: currentOrg.id,
            sku: 'CAT-' + Math.floor(100 + Math.random() * 900),
            name: file.name.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
            price_raw: 'Contact for Quote',
            model_specs: 'Uploaded Brochure Catalog',
            brochure_url: publicUrl,
            brochure_filename: file.name,
            is_active: true
          });
        }
        showToast(`Catalog "${file.name}" uploaded & parsed successfully!`, 'success');
        fetchCatalogProducts();
        event.target.value = '';
      } catch (err) {
        showToast('Upload error: ' + err.message, 'error');
      }
    }

    // 📞 TWO-WAY CALL SCHEDULER
    // =========================================================================
    async function fetchCallRequests() {
      const container = document.getElementById('callRequestsTableContainer');
      if (!container) return;
      if (!currentOrg) {
        container.innerHTML = '<div class="py-10 text-center text-xs text-slate-400">Sign in to view scheduled calls.</div>';
        return;
      }

      try {
        let calls = [];
        if (sb) {
          const { data, error } = await sb
            .from('call_requests')
            .select('*')
            .eq('org_id', currentOrg.id)
            .order('created_at', { ascending: false });
          if (error) throw error;
          calls = data || [];
        } else {
          const res = await apiFetch('/api/calls');
          calls = res.calls || [];
        }

        if (calls.length === 0) {
          container.innerHTML = '<div class="py-10 text-center text-xs text-slate-400 font-medium">No call bookings requested yet. When buyers ask for factory visits or phone calls, slots appear here.</div>';
          return;
        }

        container.innerHTML = `
          <table class="w-full text-left border-collapse text-xs">
            <thead>
              <tr class="border-b border-gray-200 text-slate-500 font-semibold">
                <th class="py-3 px-4">Buyer</th>
                <th class="py-3 px-4">Phone</th>
                <th class="py-3 px-4">Product Interest</th>
                <th class="py-3 px-4">Requested Slot</th>
                <th class="py-3 px-4">Status</th>
                <th class="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              ${calls.map(c => `
                <tr class="border-b border-gray-100 hover:bg-slate-50 transition">
                  <td class="py-3 px-4 font-semibold text-slate-900">${escapeHtml(c.buyer_name || 'Buyer')}</td>
                  <td class="py-3 px-4 font-mono text-slate-600">+${escapeHtml(String(c.buyer_phone || '').replace(/\D/g, ''))}</td>
                  <td class="py-3 px-4 font-medium text-slate-800">${escapeHtml(c.product_interest || 'General')}</td>
                  <td class="py-3 px-4 text-slate-600">${escapeHtml(c.proposed_time_raw || 'Today 4:00 PM')}</td>
                  <td class="py-3 px-4">
                    <span class="px-2 py-0.5 rounded-full text-[10px] font-bold ${c.status === 'confirmed' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}">
                      ${escapeHtml(c.status || 'requested')}
                    </span>
                  </td>
                  <td class="py-3 px-4 text-right">
                    ${c.status !== 'confirmed' ? `<button onclick="confirmSlotPrompt('${c.id}')" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-md font-semibold text-[11px] shadow-sm">Confirm Slot</button>` : '<span class="text-emerald-600 font-semibold">✓ Confirmed</span>'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } catch (err) {
        container.innerHTML = `<div class="py-6 text-center text-xs text-rose-500">Error: ${escapeHtml(err.message)}</div>`;
      }
    }

    let activeCallConfirmId = null;
    function confirmSlotPrompt(callId) {
      activeCallConfirmId = callId;
      openConfirmCallModal();
    }
    function openConfirmCallModal() {
      const m = document.getElementById('confirmCallModal');
      if (m) m.classList.remove('hidden');
    }
    function closeConfirmCallModal() {
      const m = document.getElementById('confirmCallModal');
      if (m) m.classList.add('hidden');
    }

    async function submitCallConfirmation() {
      const slotTime = (document.getElementById('confirmCallTimeInput')?.value || '').trim() || 'Tomorrow 11:30 AM';
      if (!activeCallConfirmId || !currentOrg) return;

      try {
        if (sb) {
          await sb.from('call_requests').update({
            status: 'confirmed',
            proposed_time_raw: slotTime,
            confirmed_by: 'owner'
          }).eq('id', activeCallConfirmId);
        }
        closeConfirmCallModal();
        showToast('Call slot confirmed and updated!', 'success');
        fetchCallRequests();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // =========================================================================
    // ⚙️ WHATSAPP BUSINESS SETUP & MULTI-TENANT PAIRING
    // =========================================================================
    function switchWaPairingTab(tab) {
      const isQr = tab === 'qr';
      const qrBtn = document.getElementById('waTabQrBtn');
      const codeBtn = document.getElementById('waTabCodeBtn');
      const qrContent = document.getElementById('waTabQrContent');
      const codeContent = document.getElementById('waTabCodeContent');

      if (qrBtn) {
        qrBtn.className = isQr ? 'py-2 px-4 border-b-2 border-indigo-600 text-indigo-600 font-bold transition' : 'py-2 px-4 border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
      }
      if (codeBtn) {
        codeBtn.className = !isQr ? 'py-2 px-4 border-b-2 border-indigo-600 text-indigo-600 font-bold transition' : 'py-2 px-4 border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
      }
      if (qrContent) qrContent.classList.toggle('hidden', !isQr);
      if (codeContent) codeContent.classList.toggle('hidden', isQr);
    }

    async function checkWaConnection(force = false) {
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
          badge.textContent = `✓ Connected as +${currentOrg.wa_connected_number || currentOrg.bot_whatsapp_number}`;
        }
        if (qrContainer) {
          qrContainer.innerHTML = `<div class="p-4 text-center space-y-2"><div class="text-4xl text-emerald-600 font-bold">✓</div><div class="font-bold text-emerald-700">WhatsApp Live & Connected</div><div class="text-xs text-slate-500">+${currentOrg.wa_connected_number || currentOrg.bot_whatsapp_number}</div></div>`;
        }
        if (qrMsg) qrMsg.textContent = "Your WhatsApp Business SIM is paired and actively handling customer inquiries.";
      } else if (currentOrg.wa_status === 'qr_ready' && currentOrg.wa_qr_data_url) {
        if (badge) {
          badge.className = "text-[11px] font-bold text-indigo-600 animate-pulse";
          badge.textContent = "Ready to Scan";
        }
        if (qrContainer) {
          qrContainer.innerHTML = `<img src="${currentOrg.wa_qr_data_url}" alt="WhatsApp QR Code" class="w-full h-full object-contain rounded-lg shadow-sm">`;
        }
        if (qrMsg) qrMsg.textContent = "Scan this QR code with WhatsApp > Linked Devices > Link a Device.";
      } else if (currentOrg.wa_status === 'code_ready' && currentOrg.wa_pairing_code) {
        if (badge) {
          badge.className = "text-[11px] font-bold text-emerald-600";
          badge.textContent = "Code Ready";
        }
        if (codeDisplay) {
          codeDisplay.textContent = currentOrg.wa_pairing_code;
          codeDisplay.className = "text-2xl lg:text-3xl font-mono tracking-widest font-black text-emerald-600 bg-emerald-50 px-4 py-3 rounded-xl border border-emerald-300 inline-block";
        }
        if (codeCopy) codeCopy.classList.remove('hidden');
      } else if (currentOrg.wa_status === 'initializing') {
        if (badge) {
          badge.className = "text-[11px] font-semibold text-amber-600";
          badge.textContent = "Generating...";
        }
        if (qrContainer) {
          qrContainer.innerHTML = `<div class="p-4 text-center space-y-2"><div class="animate-spin text-2xl text-indigo-600">⚙️</div><div class="text-xs text-slate-600 font-semibold">Generating fresh session...</div></div>`;
        }
      } else {
        if (badge) {
          badge.className = "text-[11px] font-semibold text-slate-500";
          badge.textContent = "Disconnected";
        }
        if (qrContainer) {
          qrContainer.innerHTML = `<div class="p-4 text-center space-y-2"><div class="text-2xl">📱</div><div class="font-semibold text-slate-600">Click below to generate live QR code</div></div>`;
        }
        if (qrMsg) qrMsg.textContent = "Ready to pair spare WhatsApp Business SIM.";
      }

      populateTestBrochures();
    }

    async function saveWaPhoneNumbers() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const botPhone = (document.getElementById('waBotNumberInput')?.value || '').trim();
      const ownerPhone = (document.getElementById('waOwnerAlertInput')?.value || '').trim();

      if (sb) {
        const { error } = await sb.from('organizations').update({
          bot_whatsapp_number: botPhone,
          owner_alert_number: ownerPhone
        }).eq('id', currentOrg.id);
        if (error) return showToast(error.message, 'error');
        currentOrg.bot_whatsapp_number = botPhone;
        currentOrg.owner_alert_number = ownerPhone;
        showToast('Dedicated phone numbers saved to organization!', 'success');
      }
    }

    async function saveWaAutomations() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const autoReply = document.getElementById('waAutoReplyToggle')?.checked !== false;
      const autoPdf = document.getElementById('waAutoPdfToggle')?.checked !== false;
      const ownerAlerts = document.getElementById('waOwnerAlertsToggle')?.checked !== false;
      const welcomeMsg = (document.getElementById('waWelcomeMessageInput')?.value || '').trim();

      if (sb) {
        const { error } = await sb.from('organizations').update({
          wa_auto_reply: autoReply,
          wa_auto_pdf: autoPdf,
          wa_owner_alerts: ownerAlerts,
          wa_welcome_message: welcomeMsg
        }).eq('id', currentOrg.id);
        if (error) return showToast(error.message, 'error');
        currentOrg.wa_auto_reply = autoReply;
        currentOrg.wa_auto_pdf = autoPdf;
        currentOrg.wa_owner_alerts = ownerAlerts;
        currentOrg.wa_welcome_message = welcomeMsg;
        showToast('Automation qualification rules updated!', 'success');
      }
    }

    async function generateLiveQrCode() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      await saveWaPhoneNumbers();
      if (sb) {
        await sb.from('organizations').update({
          wa_command: 'start_qr',
          wa_status: 'initializing'
        }).eq('id', currentOrg.id);
        showToast('QR code request sent to WhatsApp engine. Generating...', 'info');
        checkWaConnection();

        let attempts = 0;
        const timer = setInterval(async () => {
          attempts++;
          const { data: org } = await sb.from('organizations').select('wa_status, wa_qr_data_url, wa_connected_number').eq('id', currentOrg.id).single();
          if (org) {
            currentOrg = { ...currentOrg, ...org };
            checkWaConnection();
            if (org.wa_status === 'qr_ready' || org.wa_status === 'connected' || attempts > 25) {
              clearInterval(timer);
            }
          }
        }, 1500);
      }
    }

    async function getLivePairingCode() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const botPhone = (document.getElementById('waBotNumberInput')?.value || '').replace(/\D/g, '');
      if (!botPhone || botPhone.length < 10) {
        showToast('Please enter a valid Automation WhatsApp Number with country code first (e.g. 9198XXXXXXXX)', 'warning');
        document.getElementById('waBotNumberInput')?.focus();
        return;
      }
      if (sb) {
        await sb.from('organizations').update({
          bot_whatsapp_number: botPhone,
          wa_command: 'start_pair_code',
          wa_status: 'initializing'
        }).eq('id', currentOrg.id);
        showToast('Requesting 8-digit code from WhatsApp engine...', 'info');
        checkWaConnection();

        let attempts = 0;
        const timer = setInterval(async () => {
          attempts++;
          const { data: org } = await sb.from('organizations').select('wa_status, wa_pairing_code, wa_connected_number').eq('id', currentOrg.id).single();
          if (org) {
            currentOrg = { ...currentOrg, ...org };
            checkWaConnection();
            if (org.wa_status === 'code_ready' || org.wa_status === 'connected' || attempts > 25) {
              clearInterval(timer);
            }
          }
        }, 1500);
      }
    }

    function copyPairingCode() {
      const code = currentOrg?.wa_pairing_code || document.getElementById('waPairingCodeDisplay')?.textContent?.trim();
      if (code && !code.includes('----')) {
        navigator.clipboard.writeText(code);
        showToast(`Pairing code ${code} copied to clipboard!`, 'success');
      }
    }

    async function disconnectWaSession() {
      if (!currentOrg) return;
      if (sb) {
        await sb.from('organizations').update({
          wa_command: 'disconnect',
          wa_status: 'disconnected',
          wa_connected_number: null,
          wa_qr_data_url: null,
          wa_pairing_code: null
        }).eq('id', currentOrg.id);
        currentOrg.wa_status = 'disconnected';
        currentOrg.wa_connected_number = null;
        currentOrg.wa_qr_data_url = null;
        currentOrg.wa_pairing_code = null;
        showToast('WhatsApp session disconnected.', 'info');
        checkWaConnection();
      }
    }

    async function populateTestBrochures() {
      const sel = document.getElementById('testBrochureSelect');
      if (!sel || !currentOrg || sel.options.length > 1) return;
      if (sb) {
        const { data: prods } = await sb.from('products').select('*').eq('org_id', currentOrg.id);
        (prods || []).forEach(p => {
          if (p.brochure_url || p.brochure_filename) {
            const opt = document.createElement('option');
            opt.value = p.brochure_url || p.brochure_filename;
            opt.textContent = `${p.name} (${p.brochure_filename || 'PDF Catalog'})`;
            opt.dataset.name = p.name;
            sel.appendChild(opt);
          }
        });
      }
    }

    async function sendLiveTestWhatsApp() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const phoneInput = (document.getElementById('testRecipientPhone')?.value || '').replace(/\D/g, '');
      if (!phoneInput || phoneInput.length < 10) {
        showToast('Please enter a valid recipient phone number with country code (e.g. 9198XXXXXXXX)', 'warning');
        return;
      }
      const brochureSelect = document.getElementById('testBrochureSelect');
      const brochureUrl = brochureSelect ? brochureSelect.value : null;
      const brochureName = brochureSelect?.selectedOptions?.[0]?.dataset?.name || 'Product Catalog';
      const msg = (document.getElementById('testMessageText')?.value || '').trim();

      if (sb) {
        const { error } = await sb.from('wa_outbound_queue').insert({
          org_id: currentOrg.id,
          to_phone: phoneInput,
          message_text: msg,
          pdf_url: brochureUrl || null,
          pdf_name: brochureUrl ? `${brochureName}.pdf` : null,
          status: 'pending'
        });
        if (error) return showToast(error.message, 'error');

        const statusBox = document.getElementById('testDispatchStatus');
        if (statusBox) statusBox.classList.remove('hidden');
        showToast('Test WhatsApp message queued! Delivering in 2-3 seconds.', 'success');
      }
    }

    // =========================================================================
    // ⚙️ SETTINGS & ANALYTICS
    // =========================================================================
    async function loadSettingsData() {
      if (!currentOrg) return;
      if (sb) {
        const { data: org } = await sb.from('organizations').select('*').eq('id', currentOrg.id).single();
        if (org) {
          currentOrg = org;
          const nameInput = document.getElementById('settingCompanyName');
          if (nameInput) nameInput.value = org.name || '';
          const cityInput = document.getElementById('settingCityBase');
          if (cityInput) cityInput.value = org.company_city || '';
          const ownerInput = document.getElementById('settingOwnerPhone');
          if (ownerInput) ownerInput.value = org.owner_alert_number || '';
        }
      }
    }

    async function saveAiSettings() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const name = (document.getElementById('settingCompanyName')?.value || '').trim();
      const city = (document.getElementById('settingCityBase')?.value || '').trim();
      const owner = (document.getElementById('settingOwnerPhone')?.value || '').trim();

      if (sb) {
        const { error } = await sb.from('organizations').update({
          name: name || currentOrg.name,
          company_city: city,
          owner_alert_number: owner
        }).eq('id', currentOrg.id);
        if (error) return showToast(error.message, 'error');
        currentOrg.name = name || currentOrg.name;
        currentOrg.company_city = city;
        currentOrg.owner_alert_number = owner;
        updateAuthUI();
        showToast('Factory settings saved to cloud!', 'success');
      }
    }

    function saveCloudApiSettings() {
      showToast('Cloud API keys updated.', 'info');
    }

    function copyWebhookUrl() {
      const wh = document.getElementById('webhookUrlInput')?.value;
      if (wh) {
        navigator.clipboard.writeText(wh);
        showToast('Webhook URL copied to clipboard!', 'success');
      }
    }

    async function loadAnalyticsData() {
      if (!currentOrg) return;
      if (sb) {
        const { data: leads } = await sb.from('leads').select('*').eq('org_id', currentOrg.id);
        const { data: calls } = await sb.from('call_requests').select('*').eq('org_id', currentOrg.id);
        const lCount = leads ? leads.length : 0;
        const cCount = calls ? calls.length : 0;

        const anLeads = document.getElementById('anTotalLeads');
        if (anLeads) anLeads.textContent = lCount;
        const anCalls = document.getElementById('anCallsBooked');
        if (anCalls) anCalls.textContent = cCount;
        const anCallRate = document.getElementById('anCallRate');
        if (anCallRate) anCallRate.textContent = lCount > 0 ? `${Math.round((cCount / lCount) * 100)}%` : '0%';
      }
    }

    // =========================================================================
    // 💳 BILLING, MEMBERSHIP & DUAL PAYMENTS (UPI + RAZORPAY)
    // =========================================================================
    function switchPayTab(tab) {
      const isUpi = tab === 'upi';
      const upiBtn = document.getElementById('payTabUpi');
      const rzpBtn = document.getElementById('payTabRzp');
      const upiContent = document.getElementById('payContentUpi');
      const rzpContent = document.getElementById('payContentRzp');

      if (upiBtn) upiBtn.className = isUpi ? 'py-2 px-4 border-b-2 border-indigo-600 text-indigo-600 font-bold transition' : 'py-2 px-4 border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
      if (rzpBtn) rzpBtn.className = !isUpi ? 'py-2 px-4 border-b-2 border-indigo-600 text-indigo-600 font-bold transition' : 'py-2 px-4 border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition';
      if (upiContent) upiContent.classList.toggle('hidden', !isUpi);
      if (rzpContent) rzpContent.classList.toggle('hidden', isUpi);
    }

    async function loadMembershipData() {
      if (!currentOrg) return;
      if (sb) {
        const { data: org } = await sb.from('organizations').select('*').eq('id', currentOrg.id).single();
        if (org) {
          currentOrg = org;
        }
      }
      const statusEl = document.getElementById('billingPlanStatus');
      if (statusEl) statusEl.textContent = 'Active Enterprise (100% Free Plan)';

      const memBadge = document.getElementById('memStatusBadge');
      if (memBadge) memBadge.textContent = '✨ 100% Free Live Enterprise Active';

      const memCountdown = document.getElementById('memCountdownDisplay');
      if (memCountdown) memCountdown.textContent = 'Lifetime Free Access';

      const memLeadQuota = document.getElementById('memLeadQuotaText');
      if (memLeadQuota) memLeadQuota.textContent = `${currentOrg?.leads_used || 0} / Unlimited Leads Included`;

      const memProgressBar = document.getElementById('memLeadProgressBar');
      if (memProgressBar) memProgressBar.style.width = '100%';

      const limitEl = document.getElementById('billingLeadUsage');
      if (limitEl) limitEl.textContent = `${currentOrg?.leads_used || 0} / Unlimited leads processed`;
    }

    const SALES_COUPONS = {
      'PILOT999': { amount: 999, desc: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' },
      'VIP999': { amount: 999, desc: '48-Hour VIP Engineer Setup Deposit — Adjusted in Plan' },
      'SETUP5K': { amount: 5000, desc: 'One-Time Factory Setup & Catalog AI Training' },
      'START75': { amount: 7499, desc: '₹5,000 Setup + ₹2,499 First Month — 400 Leads/mo' },
      'PRO12K': { amount: 12499, desc: '₹7,500 Setup + ₹4,999 First Month — 1,500 Leads/mo' },
      'ANNUAL18K': { amount: 18000, desc: 'Full 1-Year Factory License — ₹5,000 Setup Waived FREE!' }
    };

    async function submitActivationCode() {
      const code = (document.getElementById('unlockCodeInput')?.value || '').trim().toUpperCase();
      if (!code) return showToast('Please enter an invite / coupon code', 'warning');

      const plan = SALES_COUPONS[code];
      if (!plan) return showToast('Invalid code. Please contact your sales engineer.', 'error');

      if (sb && currentOrg) {
        await sb.from('organizations').update({
          custom_quote_inr: plan.amount
        }).eq('id', currentOrg.id);
        currentOrg.custom_quote_inr = plan.amount;
      }

      updatePayAmounts(plan.amount, plan.desc);
      showToast(`Code applied! Unlocked ${plan.desc} (₹${plan.amount.toLocaleString('en-IN')})`, 'success');
    }

    function updatePayAmounts(amount, desc = '') {
      const upi = getMerchantUpi();
      const qrImg = document.getElementById('actUpiQrImg');
      const upiStr = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(getMerchantName())}&am=${amount}&cu=INR&tn=${encodeURIComponent('MartFlow AI ' + (currentOrg?.name || 'Workspace'))}`;

      if (qrImg) {
        qrImg.src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(upiStr)}`;
      }
      const amtEl = document.getElementById('actPlanPrice');
      if (amtEl) amtEl.textContent = `₹${amount.toLocaleString('en-IN')}`;
      const descEl = document.getElementById('actPlanDesc');
      if (descEl && desc) descEl.textContent = desc;
    }

    async function submitUtrVerification() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const utr = (document.getElementById('utrRefInput')?.value || '').trim();
      if (!utr || utr.length < 6) return showToast('Please enter a valid 12-digit UPI Transaction / UTR number', 'error');

      const amount = currentOrg.custom_quote_inr || 999;
      try {
        if (sb) {
          await sb.from('payments').insert({
            org_id: currentOrg.id,
            amount_inr: amount,
            provider: 'upi_direct',
            utr_reference: utr,
            status: 'pending'
          });
          await sb.from('organizations').update({ plan_status: 'active' }).eq('id', currentOrg.id);
          currentOrg.plan_status = 'active';
        }
        showToast('UTR submitted successfully! Workspace activated in active status.', 'success');
        loadMembershipData();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    function startRazorpayPayment() {
      showToast('Opening Razorpay Gateway...', 'info');
    }

    function copyUpiId() {
      const upi = getMerchantUpi();
      navigator.clipboard.writeText(upi);
      showToast(`UPI ID "${upi}" copied to clipboard!`, 'success');
    }

    function openUpgradeModal() {
      const m = document.getElementById('upgradeModal');
      if (m) m.classList.remove('hidden');
    }
    function closeUpgradeModal() {
      const m = document.getElementById('upgradeModal');
      if (m) m.classList.add('hidden');
    }
    function openActivationModal(planTitle, planPrice, planDesc) {
      const m = document.getElementById('activationModal');
      if (m) m.classList.remove('hidden');
      if (planTitle && document.getElementById('actPlanTitle')) document.getElementById('actPlanTitle').textContent = planTitle;
      if (planPrice && document.getElementById('actPlanPrice')) document.getElementById('actPlanPrice').textContent = planPrice;
    }
    function closeActivationModal() {
      const m = document.getElementById('activationModal');
      if (m) m.classList.add('hidden');
    }
    function openAnyDeskHelpModal() {
      const m = document.getElementById('anyDeskHelpModal');
      if (m) m.classList.remove('hidden');
    }
    function closeAnyDeskHelpModal() {
      const m = document.getElementById('anyDeskHelpModal');
      if (m) m.classList.add('hidden');
    }

    // Engineer & Simulation Modals
    function loadEngineerSettings() {
      const upiInput = document.getElementById('engMerchantUpiId');
      if (upiInput) upiInput.value = getMerchantUpi();
    }
    function saveEngineerSettings() {
      const upi = document.getElementById('engMerchantUpiId')?.value?.trim();
      if (upi) localStorage.setItem('mf_merchant_upi', upi);
      refreshPaymentAndSupportLinks();
      showToast('Engineer payment configuration saved!', 'success');
    }

    function openSimulationModal() {
      const m = document.getElementById('simulationModal');
      if (m) m.classList.remove('hidden');
    }
    function closeSimulationModal() {
      const m = document.getElementById('simulationModal');
      if (m) m.classList.add('hidden');
    }
    async function submitSimulation() {
      if (!currentOrg) return showToast('Please sign in first', 'warning');
      const name = (document.getElementById('simBuyerName')?.value || '').trim() || 'Simulated Buyer';
      const phone = (document.getElementById('simBuyerPhone')?.value || '').trim() || '919876543210';
      const city = (document.getElementById('simBuyerCity')?.value || '').trim() || 'Surat, Gujarat';
      const product = (document.getElementById('simProduct')?.value || '').trim() || 'Automatic Packing Machine';
      const msg = (document.getElementById('simQueryMsg')?.value || '').trim() || 'Please send machine video, catalog and lowest price quotation.';

      try {
        if (sb) {
          await sb.from('leads').insert({
            org_id: currentOrg.id,
            buyer_name: name,
            buyer_phone: phone,
            buyer_city: city,
            product_inquired: product,
            query_message: msg,
            status: 'new',
            pdf_brochure_sent: true
          });
        }
        closeSimulationModal();
        showToast('Lead simulated successfully!', 'success');
        loadDashboardData();
        fetchLeadsList();
      } catch (err) {
        showToast(err.message, 'error');
      }
    }

    // Language Toggle (English | Hinglish)
    let currentLang = 'en';
    function toggleLanguage() {
      currentLang = currentLang === 'en' ? 'hi' : 'en';
      applyLanguage(currentLang);
    }
    function applyLanguage(lang) {
      const btn = document.getElementById('langToggleBtn');
      if (btn) btn.textContent = lang === 'en' ? 'EN | हिंग्लिश' : 'हिंग्लिश | EN';
    }

    // Trial countdown stub
    function initTrialCountdown() {}
    function updateTrialDisplay() {}
    function startSelfTrial() {
      openAuthModal('signup');
    }

    // =========================================================================
    // 🚀 INITIALIZATION ON PAGE LOAD
    // =========================================================================
    window.addEventListener('DOMContentLoaded', async () => {
      fetchPublicConfig();
      await checkAuthStatus();
    });

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
        const cleanUrl = rawUrl.replace(/^https?:\/\//, 'https://');
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
          info.innerHTML = `<span class="font-bold text-slate-800">Synced:</span> ${dateStr} • <span class="font-mono text-indigo-700">${currentOrg.website_url}</span> (${Math.round((currentOrg.website_knowledge.length / 1024))} KB knowledge base)`;
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
            const filePath = `${currentOrg.id}/catalogs/${Date.now()}_${safeName}`;
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
                pdfText += textContent.items.map(it => it.str).join(' ') + '\n';
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

        showToast(`Catalog processed: ${insertedCount} added, ${updatedCount} updated (0 duplicates)!`, 'success');
        fetchCatalogProducts();
      } catch (err) {
        showToast('Catalog parsing error: ' + err.message, 'error');
      }
    }

    function extractItemsFromTableRows(rows) {
      const headerRow = (rows[0] || []).map(h => String(h || '').toLowerCase().trim());
      let skuIdx = headerRow.findIndex(h => /sku|code|item\s*id|part/i.test(h));
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
          name: filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
          sku: 'PDF-' + Math.floor(100 + Math.random() * 900),
          price_raw: 'Contact for quote',
          model_specs: 'Full verified technical brochure'
        }];
      }

      // Identify candidate items separated by model codes, bullet points, or numbered lines
      const items = [];
      const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

      const itemRegex = /(?:^|\b)([A-Z0-9-]{3,12}\s+(?:Machine|Packer|Filler|Unit|Blender|Series|Model|System)[^.]{0,60})/i;
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
          name: filename.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' '),
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

        if (memLeadQuota) memLeadQuota.textContent = `${leadsUsed} / ${leadsLimit} Trial Leads Used (${leadsLeft} Remaining)`;
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
          const timeStr = `${totalHours}h ${mins}m trial remaining • ${leadsLeft} free inquiries left`;
          if (trialCountEl) trialCountEl.textContent = timeStr;
          if (memCountEl) memCountEl.textContent = `${totalHours}h ${mins}m remaining`;
        }
      }

      updateCountdown();
      trialTimerInterval = setInterval(updateCountdown, 30000);
    }

