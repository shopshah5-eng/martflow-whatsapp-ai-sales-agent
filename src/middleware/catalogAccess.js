import db from '../db/index.js';
import { repository } from '../db/repository.js';

// Workspace ownership alone does not distinguish an agency from its client.
// Only explicit platform-managed grants (or platform superadmins) can edit.
export async function canManageCatalog(req) {
  if (req.role === 'superadmin') return true;
  if (!req.userId || !req.organizationId) return false;
  const sb = repository.getSupabase();
  if (sb) {
    const { data, error } = await sb.from('catalog_management_grants')
      .select('user_id').eq('org_id', req.organizationId).eq('user_id', req.userId).maybeSingle();
    if (error) throw Object.assign(new Error('Catalogue permissions are unavailable.'), { statusCode: 503 });
    return Boolean(data);
  }
  return Boolean(db.findOne('catalog_management_grants', grant =>
    grant.organization_id === req.organizationId && grant.user_id === req.userId));
}

export async function requireCatalogManager(req, res, next) {
  try {
    if (!await canManageCatalog(req)) return res.status(403).json({ ok: false, error: 'Catalogue editing is managed by your agency.' });
    next();
  } catch (error) {
    res.status(error.statusCode || 503).json({ ok: false, error: 'Catalogue permissions are unavailable.' });
  }
}
