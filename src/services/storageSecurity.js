import { isPublicAddress } from './safeWebsiteFetch.js';
/**
 * MartFlow AI — Storage Security, Symlink Verification & Egress SSRF Guard
 * Guarantees that attachment reads and session paths are strictly tenant-contained
 * and prevents arbitrary server file reads, symlink breakouts, and SSRF attacks.
 */

import fs from 'fs';
import path from 'path';
import net from 'net';
import https from 'https';
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

  if (fs.existsSync(tenantDir) && fs.lstatSync(tenantDir).isSymbolicLink()) {
    throw new Error('Security Violation: Symbolic links are forbidden in tenant catalog directories.');
  }
  if (fs.existsSync(baseCatalogsDir) && fs.lstatSync(baseCatalogsDir).isSymbolicLink()) {
    throw new Error('Security Violation: Symbolic links are forbidden in catalog storage.');
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
  // Hostnames are classified after DNS resolution by the caller.
  if (!net.isIP(ip)) return false;
  return !isPublicAddress(ip);
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

  const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '');
  if (!hostname || parsedUrl.username || parsedUrl.password) throw new Error('Invalid attachment host.');
  if (net.isIP(hostname) && isPrivateOrReservedIP(hostname)) {
    throw new Error(`SSRF Blocked: Destination ${hostname} is protected.`);
  }
  // Resolve all families and reject any private address. Pin the validated IPv4
  // address in the actual TLS connection to prevent DNS rebinding.
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await dns.lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateOrReservedIP(address))) {
    throw new Error('SSRF Blocked: host resolves to a protected address.');
  }
  // IPv6 literal normalization and reserved ranges are subtle. Fail closed for
  // IPv6 destinations until an audited range classifier is available.
  const chosen = addresses.find(a => a.family === 4);
  if (!chosen) throw new Error('No safe IPv4 address for attachment host.');
  const maxBytes = 10 * 1024 * 1024;
  return await new Promise((resolve, reject) => {
    const req = https.request(parsedUrl, {
      method: 'GET', headers: { 'User-Agent': 'MartFlow-MediaFetcher/2.0' },
      lookup: (_host, _options, callback) => callback(null, chosen.address, 4)
    }, response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        resolve(null);
        return;
      }
      if (Number(response.headers['content-length']) > maxBytes) {
        response.destroy(new Error('Attachment exceeds maximum permitted size of 10MB.'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error('Attachment exceeds maximum permitted size of 10MB.'));
        else chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    const timer = setTimeout(() => req.destroy(new Error('Attachment fetch timed out after 5 seconds.')), 5000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end();
  });
}
