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
    : (req.query.token || req.headers['x-session-token']);

  if (!token) {
    return res.status(401).json({
      ok: false,
      error: 'Authentication required. Please log in or provide a valid session token.'
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

  // Inject authenticated tenant context
  req.userId = payload.userId;
  req.organizationId = payload.organizationId;
  req.role = payload.role;
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
