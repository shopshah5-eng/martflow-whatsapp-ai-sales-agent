import db from '../db/index.js';
import { repository } from '../db/repository.js';

// Workspace ownership alone does not distinguish an agency from its client.
// Only explicit platform-managed grants (or platform superadmins) can edit.
export async function canManageCatalog(req) {
  if (req.role === 'superadmin') return true;
  // Catalogue targets are checked against explicit grants.
  const targetOrg = req.query?.org_id || req.body?.orgId || req.organizationId;
  if (!req.userId || !targetOrg) return false;
  const sb = repository.getSupabase();
  if (sb) {
    const { data, error } = await sb.from('catalog_management_grants')
      .select('user_id').eq('org_id', targetOrg).eq('user_id', req.userId).maybeSingle();
    if (error) throw Object.assign(new Error('Catalogue permissions are unavailable.'), { statusCode: 503 });
    return Boolean(data);
  }
  return Boolean(db.findOne('catalog_management_grants', grant =>
    (grant.organization_id === targetOrg || grant.org_id === targetOrg) && grant.user_id === req.userId));
}

export async function requireCatalogManager(req, res, next) {
  try {
    if (req.query?.org_id && req.body?.orgId && req.query.org_id !== req.body.orgId) {
      return res.status(400).json({ ok: false, error: 'Conflicting catalogue workspace targets.' });
    }
    if (!await canManageCatalog(req)) return res.status(403).json({ ok: false, error: 'Catalogue editing is managed by your agency.' });
    next();
  } catch (error) {
    res.status(error.statusCode || 503).json({ ok: false, error: 'Catalogue permissions are unavailable.' });
  }
}

// Conversation privacy: Only the client's authorized dashboard users may view that client's WhatsApp conversations.
// Admin catalogue access must NOT grant inbox access.
export async function requireConversationAccess(req, res, next) {
  try {
    if (!req.userId || !req.organizationId) {
      return res.status(401).json({ ok: false, error: 'Authentication required.' });
    }
    // Catalogue managers / agency users with role 'catalog_manager' are forbidden from client conversations
    // Ignore user-controlled query/body target when protecting the current inbox.
    const ownWorkspaceRequest = { ...req, query: {}, body: {} };
    if (req.role === 'superadmin' || req.role === 'catalog_manager' || req.isCatalogOnly || await canManageCatalog(ownWorkspaceRequest)) {
      return res.status(403).json({ ok: false, error: 'Catalogue managers cannot access conversation logs or inbox messages.' });
    }
    next();
  } catch (error) {
    res.status(error.statusCode || 503).json({ ok: false, error: 'Conversation permissions are unavailable.' });
  }
}
