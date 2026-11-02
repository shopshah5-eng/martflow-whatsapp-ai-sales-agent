/**
 * MartFlow AI — Authentication & Tenant Isolation Middleware
 * Enforces authenticated session tokens and guarantees tenant scoping on every route.
 */

import { verifySessionToken } from '../auth/authService.js';
import { repository } from '../db/repository.js';
import db from '../db/index.js';

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

    // Authoritative lookup via repository
    let organization = null;
    try {
      organization = await repository.getOrganizationById(payload.organizationId);
    } catch (e) {
      organization = db.findById('organizations', payload.organizationId);
    }

    if (!organization) {
      return res.status(403).json({
        ok: false,
        error: 'Organization no longer exists or access was revoked.'
      });
    }

    // Check current user membership and role (including membership removal and role changes)
    let membership = null;
    try {
      membership = await repository.getMembership(payload.userId, payload.organizationId);
    } catch (e) {
      membership = db.findOne('organization_members', (m) => m.organization_id === payload.organizationId && m.user_id === payload.userId);
    }

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
    return res.status(500).json({ ok: false, error: 'Authentication internal error: ' + err.message });
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

