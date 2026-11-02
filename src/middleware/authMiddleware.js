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
    if (!payload) {
      return res.status(401).json({
        ok: false,
        error: 'Invalid or expired session. Please log in again.'
      });
    }

    // No fallback to stale local membership when the authoritative database fails.
    const organization = await repository.getOrganizationById(payload.organizationId);
    if (!organization) {
      return res.status(403).json({ ok: false, error: 'Organization no longer exists or access was revoked.' });
    }
    const membership = await repository.getMembership(payload.userId, payload.organizationId);

    if (!membership) {
      return res.status(403).json({
        ok: false,
        error: 'Access denied: user is no longer a member of this organization.'
      });
    }

    // Inject verified tenant and user context from authoritative membership
    req.userId = payload.userId;
    req.organizationId = payload.organizationId;
    req.role = membership.role || payload.role;
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

