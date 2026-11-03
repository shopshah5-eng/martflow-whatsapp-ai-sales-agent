/**
 * MartFlow AI — Production Authentication & Workspace Service
 * Handles user profiles, password security, session tokens, phone OTP verification, and workspace creation.
 */

import crypto from 'crypto';
import db from '../db/index.js';
import { repository } from '../db/repository.js';
import { createClient } from '@supabase/supabase-js';

const SESSION_SECRET = process.env.SESSION_SECRET || 'martflow_sec_' + crypto.randomBytes(16).toString('hex');
const OTP_STORE = new Map(); // phone -> { otp, expiresAt, attempts }

// Password hashing using Node.js native crypto
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const keyBuffer = Buffer.from(key, 'hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(keyBuffer, derivedKey);
}

// Session Token Generation & Verification
export function createSessionToken(userId, organizationId, role) {
  const payload = {
    userId,
    organizationId,
    role,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
  };
  const str = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(str).digest('base64url');
  return `${str}.${sig}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [str, sig] = token.split('.');
  const expectedSig = crypto.createHmac('sha256', SESSION_SECRET).update(str).digest('base64url');
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
    if (Date.now() > payload.expiresAt) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// User Sign-up & Workspace Creation
export async function signUp({ email, password, fullName, companyName, phone }) {
  if (!email || !password || !fullName || !companyName) {
    throw new Error('Full Name, Business Email, Password, and Company Name are required.');
  }

  const cleanEmail = email.trim().toLowerCase();

  if (password.length < 8) {
    throw new Error('Password must be at least 8 characters long.');
  }

  // Do not mint a session for an email the user has not verified. Production
  // signup must use the configured Supabase confirmation flow instead.
  if (process.env.NODE_ENV === 'production') {
    const err = new Error('Please register through the verified signup form.');
    err.statusCode = 503;
    throw err;
  }

  const existingUser = db.findOne('profiles', (p) => p.email === cleanEmail);
  if (existingUser) {
    throw new Error('An account with this email already exists. Please log in.');
  }

  // 1. Create Profile
  const profile = db.insert('profiles', {
    email: cleanEmail,
    password_hash: hashPassword(password),
    full_name: fullName.trim(),
    phone: phone ? phone.trim() : null,
    is_email_verified: false,
    is_phone_verified: false
  });

  // 2. Create Organization (Tenant) with Unique B2B Webhook Key
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 50) + '-' + Math.random().toString(36).slice(2, 6);
  const webhookKey = 'whk_' + crypto.randomBytes(12).toString('hex');
  const organization = db.insert('organizations', {
    name: companyName.trim(),
    slug,
    webhook_key: webhookKey,
    industry: 'Machinery & Manufacturing',
    plan: 'starter',
    monthly_lead_limit: 500
  });

  // 3. Assign Creator as 'owner'
  db.insert('organization_members', {
    organization_id: organization.id,
    user_id: profile.id,
    role: 'owner'
  });

  // 4. Initialize AI Settings for Organization
  db.insert('ai_settings', {
    organization_id: organization.id,
    company_name: companyName.trim(),
    city_base: 'Industrial Area Hub',
    is_enabled: true,
    strict_catalog_only: true,
    supported_languages: ['Hinglish', 'Hindi', 'English'],
    reply_delay_sec: 5,
    send_voice_notes: true
  });

  // 5. Generate Session Token
  const token = createSessionToken(profile.id, organization.id, 'owner');

  return {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone
    },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      webhook_key: organization.webhook_key
    },
    role: 'owner',
    token
  };
}

// User Login
export async function login({ email, password }) {
  if (!email || !password) {
    throw new Error('Email and password are required.');
  }

  const cleanEmail = email.trim().toLowerCase();

  // Production Authoritative Supabase Path
  if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') {
    const sb = repository.getSupabase();
    if (!sb) {
      throw new Error('Primary authentication database is unavailable.');
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const authClient = createClient(supabaseUrl, supabaseKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    });

    const { data: authData, error: authErr } = await authClient.auth.signInWithPassword({
      email: cleanEmail,
      password
    });

    if (authErr || !authData?.user) {
      throw new Error('Invalid email or password.');
    }

    const profile = await repository.getProfileById(authData.user.id);
    if (!profile) {
      throw new Error('User profile not found.');
    }

    const orgId = profile.org_id || profile.organization_id;
    if (!orgId) {
      throw new Error('No active organization found for this user account.');
    }

    const organization = await repository.getOrganizationById(orgId);
    const membership = await repository.getMembership(authData.user.id, orgId);
    if (!organization || !membership) {
      throw new Error('No active organization or membership found for this user account.');
    }

    const token = createSessionToken(authData.user.id, organization.id, membership.role || 'member');

    return {
      user: {
        id: profile.id,
        email: profile.email,
        fullName: profile.full_name,
        phone: profile.phone
      },
      organization: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        plan: organization.plan || 'starter',
        ...(['owner', 'admin', 'superadmin'].includes(membership.role) ? { webhook_key: organization.webhook_key } : {})
      },
      role: membership.role || 'member',
      token,
      supabaseToken: authData.session?.access_token || null
    };
  }

  const profile = db.findOne('profiles', (p) => p.email === cleanEmail);
  if (!profile || !verifyPassword(password, profile.password_hash)) {
    throw new Error('Invalid email or password.');
  }

  // Find user's organization membership
  const membership = db.findOne('organization_members', (m) => m.user_id === profile.id);
  if (!membership) {
    throw new Error('No active organization found for this user account.');
  }

  const organization = db.findById('organizations', membership.organization_id);
  if (!organization) {
    throw new Error('No active organization found for this user account.');
  }

  // Ensure webhook_key exists
  if (!organization.webhook_key) {
    const key = 'whk_' + crypto.randomBytes(12).toString('hex');
    db.update('organizations', organization.id, { webhook_key: key });
    organization.webhook_key = key;
  }

  const token = createSessionToken(profile.id, organization.id, membership.role);

  return {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone
    },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      plan: organization.plan,
      ...(['owner', 'admin', 'superadmin'].includes(membership.role) ? { webhook_key: organization.webhook_key } : {})
    },
    role: membership.role,
    token
  };
}

// 1-Click Demo / Local Admin Workspace Auto-Login (Isolated Sandbox Only)
export async function demoLogin() {
  const isAllowed = process.env.ALLOW_DEMO_LOGIN === 'true' || process.env.NODE_ENV === 'test' || !process.env.NODE_ENV;
  if (process.env.NODE_ENV === 'production' || !isAllowed) {
    const err = new Error('Demo login is strictly disabled. Please sign in with registered credentials.');
    err.statusCode = 403;
    throw err;
  }

  // Isolate strictly to demo sandbox workspace — NEVER touch real tenant accounts
  const demoOrgId = 'org_demo_sandbox';
  const demoUserId = 'usr_demo_sandbox';
  let org = db.findById('organizations', demoOrgId);
  let profile = db.findById('profiles', demoUserId);

  if (!org) {
    org = db.insert('organizations', {
      id: demoOrgId,
      name: 'MartFlow Sandbox Demo (Read-Only)',
      slug: 'martflow-sandbox-demo',
      webhook_key: 'whk_sandbox_demo_' + crypto.randomBytes(8).toString('hex'),
      plan_status: 'trial',
      monthly_lead_limit: 50,
      leads_used: 0,
      industry: 'Machinery & Manufacturing'
    });
  }

  if (!profile) {
    profile = db.insert('profiles', {
      id: demoUserId,
      email: 'demo.sandbox@martflow.local',
      password_hash: hashPassword('DemoSandbox2026!'),
      full_name: 'Demo Reviewer (Sandbox)',
      phone: '919800000000',
      is_email_verified: true,
      is_phone_verified: false
    });

    db.insert('organization_members', {
      organization_id: demoOrgId,
      user_id: demoUserId,
      role: 'member'
    });
  }

  const membership = db.findOne('organization_members', (m) => m.organization_id === demoOrgId && m.user_id === demoUserId) || { role: 'member' };
  const token = createSessionToken(profile.id, org.id, membership.role);

  return {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone
    },
    organization: {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan || 'starter',
      webhook_key: org.webhook_key
    },
    role: membership.role,
    token
  };
}

// Real Phone OTP Verification Service
export async function sendPhoneOtp(phone) {
  if (!phone || phone.length < 10) {
    throw new Error('Valid phone number with country code is required.');
  }
  const cleanPhone = phone.replace(/[^0-9]/g, '');

  const otp = Math.floor(100000 + crypto.randomInt(0, 900000)).toString();
  OTP_STORE.set(cleanPhone, {
    otp,
    expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
    attempts: 0
  });

  const fast2SmsKey = process.env.FAST2SMS_API_KEY;
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;

  if (fast2SmsKey) {
    try {
      const resp = await fetch('https://www.fast2sms.com/dev/bulkV2', {
        method: 'POST',
        headers: {
          'authorization': fast2SmsKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          route: 'otp',
          variables_values: otp,
          numbers: cleanPhone.slice(-10)
        })
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || data.return === false) {
        throw new Error(data.message || 'Fast2SMS dispatch failed');
      }
      return { sent: true, phone: cleanPhone, message: 'OTP dispatched via Fast2SMS gateway.' };
    } catch (e) {
      if (process.env.NODE_ENV === 'production') throw e;
    }
  }

  if (twilioSid && twilioToken) {
    try {
      const twilioFrom = process.env.TWILIO_PHONE_NUMBER;
      const resp = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          To: `+${cleanPhone}`,
          From: twilioFrom,
          Body: `Your MartFlow verification code is: ${otp}`
        })
      });
      if (!resp.ok) throw new Error('Twilio SMS dispatch failed');
      return { sent: true, phone: cleanPhone, message: 'OTP dispatched via Twilio SMS.' };
    } catch (e) {
      if (process.env.NODE_ENV === 'production') throw e;
    }
  }

  if (process.env.NODE_ENV === 'production') {
    const err = new Error('SMS provider is not configured on this instance. Live OTP delivery is unavailable.');
    err.statusCode = 503;
    throw err;
  }

  return {
    sent: true,
    simulated: true,
    phone: cleanPhone,
    message: 'OTP generated (test mode simulated dispatch). Valid for 10 minutes.'
  };
}

export function verifyPhoneOtp(phone, inputOtp) {
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  const record = OTP_STORE.get(cleanPhone);
  if (!record) {
    throw new Error('No OTP request found for this phone number. Please request an OTP first.');
  }
  if (Date.now() > record.expiresAt) {
    OTP_STORE.delete(cleanPhone);
    throw new Error('OTP has expired. Please request a new OTP.');
  }
  if (record.attempts >= 5) {
    OTP_STORE.delete(cleanPhone);
    throw new Error('Too many failed OTP attempts. Please request a new OTP.');
  }

  record.attempts++;
  if (record.otp !== inputOtp.trim()) {
    throw new Error('Invalid OTP code. Please enter the correct code.');
  }

  OTP_STORE.delete(cleanPhone);
  return { verified: true, phone: cleanPhone };
}

// Cryptographically Validated Google / Supabase Auth Handler
export async function handleGoogleAuth({ token: inputToken, idToken, credential, email, fullName }) {
  const authToken = inputToken || idToken || credential;
  let verifiedEmail = null;
  let verifiedName = fullName || null;
  let verifiedUserId = null;

  if (authToken) {
    // Attempt Supabase Auth verification if configured
    if (process.env.SUPABASE_URL && (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY)) {
      try {
        const { createClient } = await import('@supabase/supabase-js');
        const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY, {
          auth: { persistSession: false, autoRefreshToken: false }
        });
        const { data, error } = await sb.auth.getUser(authToken);
        if (!error && data?.user?.email) {
          verifiedEmail = data.user.email.toLowerCase().trim();
          verifiedName = data.user.user_metadata?.full_name || verifiedName || verifiedEmail.split('@')[0];
          verifiedUserId = data.user.id;
        }
      } catch (e) {
        // Fall back to token decode in test mode
      }
    }

    // In test environment, accept mock verified tokens
    if (!verifiedEmail && process.env.NODE_ENV === 'test' && typeof authToken === 'string') {
      if (authToken.startsWith('mock-google-token-') || authToken.includes('@')) {
        verifiedEmail = authToken.replace('mock-google-token-', '').toLowerCase().trim();
      }
    }
  }

  // In test/dev environment, fallback to email if supplied
  if (!verifiedEmail && process.env.NODE_ENV !== 'production' && email) {
    verifiedEmail = email.trim().toLowerCase();
  }

  if (!verifiedEmail) {
    throw new Error('Valid, cryptographically verified Google identity token is required.');
  }

  const cleanEmail = verifiedEmail;
  let profile = null;

  if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') {
    profile = await repository.getProfileByEmail(cleanEmail);
  } else {
    profile = db.findOne('profiles', (p) => p.email === cleanEmail);
  }

  let organization;
  let role = 'owner';

  if (!profile) {
    // Brand new user signing in via verified Google identity
    // Security: Caller-controlled user IDs (e.g. forged supabaseId) are strictly ignored.
    const name = verifiedName ? verifiedName.trim() : cleanEmail.split('@')[0];
    const companyName = name + ' Manufacturing';
    profile = db.insert('profiles', {
      id: verifiedUserId || undefined,
      email: cleanEmail,
      full_name: name,
      auth_provider: 'google',
      is_email_verified: true,
      is_phone_verified: false
    });

    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40) + '-' + Math.random().toString(36).slice(2, 6);
    const webhookKey = 'whk_' + crypto.randomBytes(12).toString('hex');
    organization = db.insert('organizations', {
      name: companyName,
      slug,
      webhook_key: webhookKey,
      plan_status: 'trial',
      trial_ends_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      monthly_lead_limit: 25,
      leads_used: 0,
      industry: 'Machinery & Manufacturing'
    });

    db.insert('organization_members', {
      organization_id: organization.id,
      user_id: profile.id,
      role: 'owner'
    });

    db.insert('ai_settings', {
      organization_id: organization.id,
      company_name: companyName,
      city_base: 'Industrial Area Hub',
      is_enabled: true,
      strict_catalog_only: true,
      supported_languages: ['Hinglish', 'Hindi', 'English'],
      reply_delay_sec: 5,
      send_voice_notes: true
    });
  } else {
    // Existing user profile found — preserve actual tenant and membership role authoritatively
    if (process.env.NODE_ENV === 'production' && process.env.USE_LOCAL_DB !== 'true') {
      const orgId = profile.org_id || profile.organization_id;
      if (!orgId) {
        throw new Error('No active organization found for this authenticated user.');
      }
      organization = await repository.getOrganizationById(orgId);
      const membership = await repository.getMembership(profile.id, orgId);
      if (!membership || !organization) {
        throw new Error('No active organization or membership found for this authenticated user.');
      }
      role = membership.role || 'member';
    } else {
      const membership = db.findOne('organization_members', (m) => m.user_id === profile.id);
      if (membership) {
        organization = db.findById('organizations', membership.organization_id);
        role = membership.role || 'member';
      }
      if (!organization) {
        throw new Error('No active organization found for this authenticated user.');
      }
    }
  }

  const token = createSessionToken(profile.id, organization.id, role);
  return {
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name
    },
    organization: {
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      webhookKey: organization.webhook_key,
      planStatus: organization.plan_status || 'trial',
      leadsUsed: organization.leads_used || 0,
      leadLimit: organization.monthly_lead_limit || 25
    },
    role,
    token
  };
}


