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
            resolvedUserId = data.user.id;
            const profile = await repository.getProfileById(resolvedUserId);
            if (profile && (profile.org_id || profile.organization_id)) {
              resolvedOrgId = profile.org_id || profile.organization_id;
            } else {
              // Verified Supabase user without an active organization link — auto-link or provision
              const userEmail = data.user.email ? data.user.email.toLowerCase().trim() : '';
              if (userEmail) {
                const existingByEmail = await repository.getProfileByEmail(userEmail);
                if (existingByEmail && (existingByEmail.org_id || existingByEmail.organization_id)) {
                  resolvedOrgId = existingByEmail.org_id || existingByEmail.organization_id;
                  try {
                    await sb.from('profiles').update({ id: resolvedUserId }).eq('email', userEmail);
                  } catch (_) {}
                } else {
                  // Provision new trial workspace for verified user
                  const fullName = data.user.user_metadata?.full_name || userEmail.split('@')[0] || 'User';
                  const companyName = data.user.user_metadata?.company_name || fullName + ' Enterprise';
                  const crypto = await import('crypto');
                  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 6);
                  const webhookKey = 'whk_' + crypto.randomBytes(12).toString('hex');

                  const { data: newOrg, error: orgErr } = await sb.from('organizations').insert({
                    name: companyName,
                    slug,
                    webhook_key: webhookKey,
                    plan_status: 'trial',
                    trial_ends_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
                    monthly_lead_limit: 25,
                    leads_used: 0,
                    wa_status: 'disconnected'
                  }).select().single();

                  if (!orgErr && newOrg?.id) {
                    resolvedOrgId = newOrg.id;
                    await sb.from('profiles').upsert({
                      id: resolvedUserId,
                      org_id: newOrg.id,
                      full_name: fullName,
                      email: userEmail,
                      role: 'owner'
                    });
                  }
                }
              }
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
