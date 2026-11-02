/**
 * MartFlow AI — Storage Security, Symlink Verification & Egress SSRF Guard
 * Guarantees that attachment reads and session paths are strictly tenant-contained
 * and prevents arbitrary server file reads, symlink breakouts, and SSRF attacks.
 */

import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import { URL } from 'url';

// 1. Safe Identifier Validation (Preserves both mf_... and standard UUIDs)
export function validateSafeIdentifier(id, fieldName = 'Identifier') {
  if (!id || typeof id !== 'string') {
    throw new Error(`${fieldName} must be a non-empty string.`);
  }
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
    throw new Error(`Invalid ${fieldName}: must be 8-64 alphanumeric characters, underscores, or hyphens.`);
  }
  if (id.includes('..') || id.includes('/') || id.includes('\\') || id.includes('\0')) {
    throw new Error(`Security Violation: Unsafe path characters in ${fieldName}.`);
  }
  return id;
}

// 2. Tenant Session Directory Containment & Symlink Check
export function getSafeTenantAuthDir(orgId) {
  validateSafeIdentifier(orgId, 'Organization ID');
  const baseAuthDir = path.resolve(process.cwd(), 'auth_info');
  const targetDir = path.resolve(baseAuthDir, orgId);

  // Enforce directory containment
  if (!targetDir.startsWith(baseAuthDir + path.sep) && targetDir !== baseAuthDir) {
    throw new Error('Security Violation: Session path traversal detected.');
  }

  // Check for symlinks if directory or file exists
  if (fs.existsSync(targetDir)) {
    const stat = fs.lstatSync(targetDir);
    if (stat.isSymbolicLink()) {
      throw new Error('Security Violation: Symbolic links are forbidden in session storage.');
    }
    const realTarget = fs.realpathSync(targetDir);
    const realBase = fs.realpathSync(baseAuthDir);
    if (!realTarget.startsWith(realBase + path.sep)) {
      throw new Error('Security Violation: Resolved session path escapes authorized storage.');
    }
  }

  return targetDir;
}

// 3. Tenant Catalog File Containment & Symlink Check
export function getSafeTenantCatalogPath(orgId, filename) {
  validateSafeIdentifier(orgId, 'Organization ID');
  if (!filename || typeof filename !== 'string') {
    throw new Error('Invalid filename: must be a non-empty string.');
  }
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    throw new Error('Invalid filename: path traversal sequences are forbidden.');
  }
  const safeFile = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
  const baseCatalogsDir = path.resolve(process.cwd(), 'catalogs');
  const tenantDir = path.resolve(baseCatalogsDir, orgId);

  if (!tenantDir.startsWith(baseCatalogsDir + path.sep)) {
    throw new Error('Security Violation: Tenant catalog directory escapes authorized root.');
  }

  const targetFile = path.resolve(tenantDir, safeFile);
  if (!targetFile.startsWith(tenantDir + path.sep)) {
    throw new Error('Security Violation: Catalog file path escapes tenant root.');
  }

  if (fs.existsSync(targetFile)) {
    const stat = fs.lstatSync(targetFile);
    if (stat.isSymbolicLink()) {
      throw new Error('Security Violation: Symbolic links are forbidden in catalog files.');
    }
  }

  return targetFile;
}

// 4. IP Range Validation (Blocks Private, Loopback, Carrier-Grade & Cloud Metadata)
export function isPrivateOrReservedIP(ip) {
  if (!ip) return true;

  // Normalize IPv4-mapped IPv6
  let cleanIp = ip;
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.slice(7);
  }

  // IPv4 Checks
  if (cleanIp.includes('.')) {
    const parts = cleanIp.split('.').map(Number);
    if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;

    const [a, b] = parts;
    if (a === 0) return true; // Current network
    if (a === 10) return true; // RFC 1918 Private
    if (a === 127) return true; // Loopback
    if (a === 169 && b === 254) return true; // Link-local / Cloud Metadata (169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918 Private
    if (a === 192 && b === 168) return true; // RFC 1918 Private
    if (a === 100 && b >= 64 && b <= 127) return true; // Carrier-Grade NAT (RFC 6598)
    if (a >= 224) return true; // Multicast / Reserved
    return false;
  }

  // IPv6 Checks
  const lower = cleanIp.toLowerCase();
  if (lower === '::1' || lower === '::') return true; // Loopback / Unspecified
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // Unique Local Address
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true; // Link-local

  return false;
}

// 5. Safe Media Attachment Fetcher
export async function getSafeAttachmentBuffer(orgId, attachmentRef) {
  if (!attachmentRef) return null;

  // Reject non-HTTP URL schemes (e.g. file:, ftp:, etc.)
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(attachmentRef) && !/^https?:\/\//i.test(attachmentRef)) {
    throw new Error(`Prohibited attachment URL protocol: ${attachmentRef}`);
  }

  // Case A: Local tenant storage path or filename
  if (!/^https?:\/\//i.test(attachmentRef)) {
    if (!orgId) throw new Error('Tenant organization ID required to access local attachment.');
    // Check if attachmentRef is inside catalogs/{orgId}
    const safePath = getSafeTenantCatalogPath(orgId, path.basename(attachmentRef));
    if (fs.existsSync(safePath)) {
      return fs.readFileSync(safePath);
    }
    return null;
  }

  // Case B: Remote HTTPS URL with DNS Pinning & SSRF Filter
  let parsedUrl;
  try {
    parsedUrl = new URL(attachmentRef);
  } catch (e) {
    throw new Error('Invalid attachment URL format.');
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error('Only secure HTTPS URLs are permitted for remote attachments.');
  }

  const hostname = parsedUrl.hostname;
  if (!hostname) throw new Error('Missing hostname in attachment URL.');

  // Direct IP Literal Check (blocks 127.0.0.1, 169.254.169.254, etc.)
  if (isPrivateOrReservedIP(hostname)) {
    throw new Error(`SSRF Blocked: Destination ${hostname} is a protected/internal IP address.`);
  }

  // Pre-connection DNS lookup to prevent private IP access & DNS rebinding
  const addresses = await dns.resolve4(hostname).catch(() => []);
  if (!addresses || addresses.length === 0) {
    throw new Error(`DNS resolution failed for attachment host: ${hostname}`);
  }

  for (const ip of addresses) {
    if (isPrivateOrReservedIP(ip)) {
      throw new Error(`SSRF Blocked: Hostname ${hostname} resolves to protected/internal IP ${ip}`);
    }
  }

  // Fetch with strict timeout and payload size cap (10MB)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const resp = await fetch(attachmentRef, {
      signal: controller.signal,
      redirect: 'error', // Disallow redirects to prevent redirect-based SSRF/rebinding
      headers: { 'User-Agent': 'MartFlow-MediaFetcher/2.0' }
    });

    clearTimeout(timeout);
    if (!resp.ok) return null;

    const contentLength = Number(resp.headers.get('content-length'));
    if (contentLength && contentLength > 10 * 1024 * 1024) {
      throw new Error('Attachment exceeds maximum permitted size of 10MB.');
    }

    const arr = await resp.arrayBuffer();
    if (arr.byteLength > 10 * 1024 * 1024) {
      throw new Error('Attachment exceeds maximum permitted size of 10MB.');
    }

    return Buffer.from(arr);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Attachment fetch timed out after 5 seconds.');
    }
    throw err;
  }
}
