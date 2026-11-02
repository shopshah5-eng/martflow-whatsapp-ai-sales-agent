/**
 * MartFlow AI — Authentication & Tenant Isolation Middleware
 * Enforces authenticated session tokens and guarantees tenant scoping on every route.
 */

import { verifySessionToken } from '../auth/authService.js';
import db from '../db/index.js';

export function authenticate(req, res, next) {
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

  const organization = db.findById('organizations', payload.organizationId);
  if (!organization) {
    return res.status(403).json({
      ok: false,
      error: 'Organization no longer exists or access was revoked.'
    });
  }

  // Check current user membership and role (including membership removal and role changes)
  const membership = db.findOne('organization_members', (m) => m.organization_id === payload.organizationId && m.user_id === payload.userId);
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

