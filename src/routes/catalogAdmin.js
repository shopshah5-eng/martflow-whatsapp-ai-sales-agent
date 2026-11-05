import express from 'express';
import { authenticate, requireRole } from '../middleware/authMiddleware.js';
import { repository } from '../db/repository.js';
import db from '../db/index.js';

const router = express.Router();
const emailPattern = /^[^\s@]{1,64}@[^\s@]{1,189}$/;
const emailValue = v => typeof v === 'string' && emailPattern.test(v.trim()) ? v.trim().toLowerCase() : null;
const orgOf = (p, sb = null) => p?.org_id || p?.organization_id || (!sb ? db.findOne('organization_members', m => m.user_id === p?.id && m.role === 'owner')?.organization_id : null);
const unavailable = (res, error) => {
  const conflicts = new Set(['Client limit reached', 'Already assigned', 'Pending request not found', 'Limit is below assigned and pending clients']);
  if (conflicts.has(error?.message)) return res.status(409).json({ ok: false, error: error.message });
  return res.status(503).json({ ok: false, error: 'Admin management is unavailable. Verify the staged database setup.' });
};

async function getProfileByEmail(email, sb) {
  if (sb) {
    const { data, error } = await sb.from('profiles').select('id,email,org_id,full_name,role').eq('email', email).maybeSingle();
    if (error) throw error;
    return data;
  }
  return db.findOne('profiles', p => (p.email || '').toLowerCase() === email);
}
async function getAccount(userId, sb) {
  if (sb) {
    const { data, error } = await sb.from('catalog_admin_accounts').select('user_id,max_clients').eq('user_id', userId).maybeSingle();
    if (error) throw error;
    return data;
  }
  return db.findOne('catalog_admin_accounts', a => a.user_id === userId);
}
async function callRpc(sb, name, args) {
  const { error } = await sb.rpc(name, args);
  if (error) throw error;
}
async function findExisting(orgId, adminId) {
  return db.findOne('catalog_management_grants', g => (g.org_id || g.organization_id) === orgId && g.user_id === adminId);
}

// No endpoint exposes client inboxes. All target workspaces are authorized again
// by the catalogue endpoints when products are read or changed.
router.get('/catalog-admin/context', authenticate, async (req, res) => {
  try {
    const sb = repository.getSupabase();
    const superadmin = req.role === 'superadmin';
    let account = superadmin ? null : await getAccount(req.userId, sb);
    if (!superadmin && !account) return res.status(403).json({ ok: false, error: 'Admin access is not enabled for this account.' });
    let accounts = [], requests = [], grants = [], profiles = [], orgs = [];
    if (sb) {
      if (superadmin) {
        const a = await sb.from('catalog_admin_accounts').select('user_id,max_clients'); if (a.error) throw a.error; accounts = a.data || [];
        const r = await sb.from('catalog_assignment_requests').select('admin_id,org_id,status,created_at,requested_email').eq('status', 'pending'); if (r.error) throw r.error; requests = r.data || [];
      } else {
        const r = await sb.from('catalog_assignment_requests').select('admin_id,org_id,status,created_at,requested_email').eq('admin_id', req.userId); if (r.error) throw r.error; requests = r.data || [];
      }
      let g = sb.from('catalog_management_grants').select('org_id,user_id');
      if (!superadmin) g = g.eq('user_id', req.userId);
      const gr = await g; if (gr.error) throw gr.error; grants = gr.data || [];
      const ids = [...new Set([...grants.map(g => g.org_id), ...requests.map(r => r.org_id)])];
      if (ids.length) {
        const o = await sb.from('organizations').select('id,name').in('id', ids); if (o.error) throw o.error; orgs = o.data || [];
        const p = await sb.from('profiles').select('id,email,full_name,org_id,role').in('org_id', ids).eq('role', 'owner'); if (p.error) throw p.error; profiles = p.data || [];
      }
      if (superadmin && accounts.length) {
        const p = await sb.from('profiles').select('id,email,full_name,org_id,role').in('id', accounts.map(a => a.user_id));
        if (p.error) throw p.error;
        profiles.push(...(p.data || []));
      }
    } else {
      accounts = superadmin ? db.find('catalog_admin_accounts', () => true) : [];
      requests = db.find('catalog_assignment_requests', r => superadmin ? r.status === 'pending' : r.admin_id === req.userId);
      grants = db.find('catalog_management_grants', g => superadmin || g.user_id === req.userId).map(g => ({ ...g, org_id: g.org_id || g.organization_id }));
      orgs = db.find('organizations', () => true);
      profiles = db.find('profiles', () => true).map(p => ({ ...p, org_id: orgOf(p) }));
    }
    const findOrg = id => orgs.find(o => o.id === id);
    const owner = id => profiles.find(p => p.org_id === id && p.role === 'owner') || profiles.find(p => p.org_id === id);
    const client = id => ({ id, name: findOrg(id)?.name || 'Workspace', email: owner(id)?.email || null });
    const admin = id => profiles.find(p => p.id === id);
    return res.json({ ok: true, isSuperAdmin: superadmin,
      quota: account ? { max: account.max_clients, assigned: grants.length, pending: requests.filter(r => r.status === 'pending').length } : null,
      clients: superadmin ? [] : grants.map(g => client(g.org_id)),
      requests: requests.map(r => ({ adminId: r.admin_id, adminEmail: superadmin ? admin(r.admin_id)?.email || null : undefined, orgId: r.org_id, client: superadmin || grants.some(g => g.org_id === r.org_id) ? { ...client(r.org_id), email: r.requested_email || client(r.org_id).email } : { email: r.requested_email || null }, status: r.status })),
      admins: superadmin ? accounts.map(a => ({ userId: a.user_id, email: admin(a.user_id)?.email || null, maxClients: a.max_clients, assigned: grants.filter(g => g.user_id === a.user_id).length, clients: grants.filter(g => g.user_id === a.user_id).map(g => client(g.org_id)) })) : [] });
  } catch (error) { return unavailable(res, error); }
});

router.get('/catalog-admin/search', authenticate, requireRole(['superadmin']), async (req, res) => {
  const prefix = String(req.query?.email || '').trim().toLowerCase();
  if (prefix.length < 3 || prefix.length > 100 || !/^[a-z0-9@.+-]+$/.test(prefix)) return res.status(400).json({ ok: false, error: 'Enter at least three email characters (letters, digits, @, dot, plus or hyphen).' });
  try {
    const sb = repository.getSupabase(); let profiles;
    if (sb) {
      const result = await sb.from('profiles').select('id,email,org_id,full_name').like('email', `${prefix}%`).limit(25);
      if (result.error) throw result.error; profiles = result.data || [];
    } else profiles = db.find('profiles', p => (p.email || '').toLowerCase().startsWith(prefix)).slice(0, 25).map(p => ({ id: p.id, email: p.email, org_id: orgOf(p), full_name: p.full_name }));
    res.json({ ok: true, accounts: profiles });
  } catch (error) { return unavailable(res, error); }
});

router.post('/catalog-admin/admins', authenticate, requireRole(['superadmin']), async (req, res) => {
  const email = emailValue(req.body?.email), max = Number(req.body?.maxClients), enabled = req.body?.enabled;
  if (!email || !Number.isInteger(max) || max < 1 || max > 100 || typeof enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'Enter an existing admin email and a client limit from 1 to 100.' });
  try {
    const sb = repository.getSupabase(); const profile = await getProfileByEmail(email, sb);
    if (!profile) return res.status(404).json({ ok: false, error: 'Account not found. The admin must register first.' });
    if (profile.id === req.userId) return res.status(400).json({ ok: false, error: 'Use a separate catalogue admin account.' });
    if (sb) await callRpc(sb, 'catalog_admin_set', { p_user_id: profile.id, p_max_clients: max, p_enabled: enabled });
    else {
      const existing = await getAccount(profile.id, sb);
      const current = db.find('catalog_management_grants', g => g.user_id === profile.id);
      if (enabled && current.length + db.find('catalog_assignment_requests', r => r.admin_id === profile.id && r.status === 'pending').length > max) return res.status(409).json({ ok: false, error: 'Remove assignments or reject pending requests before reducing the limit.' });
      if (enabled && existing) db.update('catalog_admin_accounts', existing.id, { max_clients: max });
      else if (enabled) db.insert('catalog_admin_accounts', { user_id: profile.id, max_clients: max });
      else {
        for (const g of current) db.delete('catalog_management_grants', g.id);
        for (const r of db.find('catalog_assignment_requests', r => r.admin_id === profile.id)) db.delete('catalog_assignment_requests', r.id);
        if (existing) db.delete('catalog_admin_accounts', existing.id);
      }
    }
    res.json({ ok: true });
  } catch (error) { return unavailable(res, error); }
});

router.post('/catalog-admin/requests', authenticate, async (req, res) => {
  const clientEmail = emailValue(req.body?.clientEmail);
  const adminEmail = req.role === 'superadmin' ? emailValue(req.body?.adminEmail) : null;
  if (!clientEmail || (req.role === 'superadmin' && !adminEmail)) return res.status(400).json({ ok: false, error: 'Enter valid registered email addresses.' });
  try {
    const sb = repository.getSupabase();
    const admin = adminEmail ? await getProfileByEmail(adminEmail, sb) : { id: req.userId };
    const account = admin && await getAccount(admin.id, sb);
    if (!account) return res.status(403).json({ ok: false, error: 'Catalogue admin access is not enabled.' });
    const profile = await getProfileByEmail(clientEmail, sb); const orgId = orgOf(profile, sb);
    if (!profile || !orgId || profile.id === admin.id) return res.status(404).json({ ok: false, error: 'Eligible registered client not found.' });
    if (sb) await callRpc(sb, 'catalog_admin_request', { p_admin_id: admin.id, p_org_id: orgId, p_client_email: clientEmail });
    else {
      if (await findExisting(orgId, admin.id)) return res.status(409).json({ ok: false, error: 'Client is already assigned.' });
      const pending = db.find('catalog_assignment_requests', r => r.admin_id === admin.id && r.status === 'pending' && r.org_id !== orgId);
      const count = db.find('catalog_management_grants', g => g.user_id === admin.id).length + pending.length;
      if (count >= account.max_clients) return res.status(409).json({ ok: false, error: 'Client limit reached.' });
      const existing = db.findOne('catalog_assignment_requests', r => r.admin_id === admin.id && r.org_id === orgId);
      if (existing) db.update('catalog_assignment_requests', existing.id, { status: 'pending', requested_email: clientEmail });
      else db.insert('catalog_assignment_requests', { admin_id: admin.id, org_id: orgId, status: 'pending', requested_email: clientEmail });
    }
    res.json({ ok: true, message: 'Request submitted for super-admin approval.' });
  } catch (error) { return unavailable(res, error); }
});

router.post('/catalog-admin/review', authenticate, requireRole(['superadmin']), async (req, res) => {
  const { adminId, orgId, approve } = req.body || {};
  if (typeof adminId !== 'string' || typeof orgId !== 'string' || typeof approve !== 'boolean') return res.status(400).json({ ok: false, error: 'Invalid request.' });
  try {
    const sb = repository.getSupabase();
    if (sb) await callRpc(sb, 'catalog_admin_review', { p_admin_id: adminId, p_org_id: orgId, p_approve: approve, p_actor: req.userId });
    else {
      const account = await getAccount(adminId, sb);
      const pending = db.findOne('catalog_assignment_requests', r => r.admin_id === adminId && r.org_id === orgId && r.status === 'pending');
      if (!account || !pending) return res.status(404).json({ ok: false, error: 'Pending request not found.' });
      if (approve && !(await findExisting(orgId, adminId))) {
        if (db.find('catalog_management_grants', g => g.user_id === adminId).length >= account.max_clients) return res.status(409).json({ ok: false, error: 'Client limit reached.' });
        db.insert('catalog_management_grants', { org_id: orgId, organization_id: orgId, user_id: adminId, granted_by: req.userId });
      }
      db.update('catalog_assignment_requests', pending.id, { status: approve ? 'approved' : 'rejected' });
    }
    res.json({ ok: true });
  } catch (error) { return unavailable(res, error); }
});

router.delete('/catalog-admin/assignments/:orgId', authenticate, async (req, res) => {
  const adminId = req.role === 'superadmin' ? req.body?.adminId : req.userId;
  if (typeof adminId !== 'string' || !adminId) return res.status(400).json({ ok: false, error: 'Select an admin.' });
  try {
    const sb = repository.getSupabase();
    if (!await getAccount(adminId, sb)) return res.status(403).json({ ok: false, error: 'Catalogue admin access is not enabled.' });
    if (sb) await callRpc(sb, 'catalog_admin_remove', { p_admin_id: adminId, p_org_id: req.params.orgId });
    else {
      const grant = await findExisting(req.params.orgId, adminId); if (grant) db.delete('catalog_management_grants', grant.id);
      const r = db.findOne('catalog_assignment_requests', x => x.admin_id === adminId && x.org_id === req.params.orgId); if (r) db.delete('catalog_assignment_requests', r.id);
    }
    res.json({ ok: true });
  } catch (error) { return unavailable(res, error); }
});
export default router;
