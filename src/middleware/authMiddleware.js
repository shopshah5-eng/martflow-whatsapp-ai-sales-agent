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

    if (payload) {
      resolvedUserId = payload.userId;
      resolvedOrgId = payload.organizationId;
    } else {
      // Compatibility: Verify Supabase Auth JWT server-side
      const sb = repository.getSupabase();
      if (sb) {
        try {
          const { data, error } = await sb.auth.getUser(token);
          if (!error && data?.user?.id) {
            // Unconfirmed identities must never be authenticated to a workspace
            const isExplicitlyUnconfirmed = (data.user.email_confirmed_at === null && data.user.confirmed_at === null) &&
              data.user.app_metadata?.provider !== 'google';
            if (isExplicitlyUnconfirmed) {
              return res.status(401).json({
                ok: false,
                error: 'Email confirmation required. Please verify your email before accessing your workspace.'
              });
            }

            resolvedUserId = data.user.id;
            // Strict authorization: Look up profile strictly by verified user ID.
            // Never reassign profiles or link accounts based only on an email match.
            // Never create workspaces as a side effect of an ordinary authenticated request.
            const profile = await repository.getProfileById(resolvedUserId);
            if (profile && (profile.org_id || profile.organization_id)) {
              resolvedOrgId = profile.org_id || profile.organization_id;
            }
          }
        } catch (e) {
          if (e.statusCode) throw e;
        }
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
    req.role = membership.role || 'member';
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
