/**
 * MartFlow AI — Authentication & Tenant Isolation Middleware
 * Enforces authenticated session tokens and guarantees tenant scoping on every route.
 */

import { verifySessionToken } from '../auth/authService.js';
import { repository } from '../db/repository.js';

export async function authenticate(req, res, next) {
  try {
    // Allow platform finance / superadmin key for administrative operations
    const platformAdminKey = req.headers['x-platform-admin-key'];
    const expectedAdminKey = process.env.PLATFORM_ADMIN_SECRET;
    if (platformAdminKey && expectedAdminKey && platformAdminKey === expectedAdminKey) {
      req.userId = 'platform_admin';
      req.organizationId = 'platform';
      req.role = 'superadmin';
      return next();
    }

    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim()
      : req.headers['x-session-token'];

    if (!token) {
      return res.status(401).json({
        ok: false,
        error: 'Authentication required. Please provide a valid Bearer token in the Authorization header.'
      });
    }

    const payload = verifySessionToken(token);
    let resolvedUserId = null;
    let resolvedOrgId = null;
    let resolvedRole = null;

    if (payload) {
      resolvedUserId = payload.userId;
      resolvedOrgId = payload.organizationId;
      resolvedRole = payload.role;
    } else {
      // Compatibility: Verify Supabase Auth JWT server-side
      const sb = repository.getSupabase();
      if (sb) {
        try {
          const { data, error } = await sb.auth.getUser(token);
          if (!error && data?.user?.id) {
            resolvedUserId = data.user.id;
            let profile = await repository.getProfileById(resolvedUserId);
            if (!profile) {
              try {
                const orgName = data.user.user_metadata?.company_name || (data.user.user_metadata?.full_name ? data.user.user_metadata.full_name + ' Enterprise' : 'My Enterprise');
                const newOrg = await repository.createOrganization({
                  name: orgName,
                  slug: 'org-' + Date.now().toString(36),
                  plan_status: 'trial'
                });
                if (newOrg?.id) {
                  profile = await repository.createProfile({
                    id: resolvedUserId,
                    org_id: newOrg.id,
                    email: data.user.email,
                    full_name: data.user.user_metadata?.full_name || data.user.email?.split('@')[0] || 'Member',
                    role: 'owner'
                  });
                }
              } catch (provErr) {
                console.warn('Auto-provisioning notice in authMiddleware:', provErr.message);
              }
            }
            if (profile && (profile.org_id || profile.organization_id)) {
              resolvedOrgId = profile.org_id || profile.organization_id;
              resolvedRole = profile.role || 'owner';
            }
          }
        } catch (e) {}
      }
    }

    if (!resolvedUserId || !resolvedOrgId) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or expired session. Please log in again.'
      });
    }

    // No fallback to stale local membership when the authoritative database fails.
    const organization = await repository.getOrganizationById(resolvedOrgId);
    if (!organization) {
      return res.status(403).json({ ok: false, error: 'Organization no longer exists or access was revoked.' });
    }
    const membership = await repository.getMembership(resolvedUserId, resolvedOrgId);

    if (!membership) {
      return res.status(403).json({
        ok: false,
        error: 'Access denied: user is no longer a member of this organization.'
      });
    }

    // Inject verified tenant and user context from authoritative membership
    req.userId = resolvedUserId;
    req.organizationId = resolvedOrgId;
    req.role = membership.role || resolvedRole || 'member';
    req.organization = organization;

    next();
  } catch (err) {
    return res.status(err.statusCode || 503).json({ ok: false, error: 'Authentication database unavailable.' });
  }
}

// Role-Based Access Control (RBAC)
export function requireRole(allowedRoles = []) {
  return (req, res, next) => {
    if (!req.role) {
      return res.status(401).json({ ok: false, error: 'Unauthorized.' });
    }

    if (!allowedRoles.includes(req.role)) {
      return res.status(403).json({
        ok: false,
        error: `Permission denied. Required role: [${allowedRoles.join(', ')}]. Current role: '${req.role}'.`
      });
    }

    next();
  };
}

