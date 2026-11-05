import dns from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

// Reject special-purpose, local, multicast and mapped addresses. Resolve every
// address before connecting and pin a checked address in the connection itself.
export function isPublicAddress(address) {
  if (!ipaddr.isValid(address)) return false;
  let ip = ipaddr.parse(address);
  if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
  return ip.range() === 'unicast';
}

async function resolveTarget(urlString, lookup = dns.lookup) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid website URL');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || /\.(local|localhost|internal)\.?$/.test(host)) throw new Error('Forbidden host');
  const family = net.isIP(host);
  const addresses = family ? [{ address: host, family }] : await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Forbidden address');
  return { url, address: addresses[0] };
}

export async function isSafePublicUrl(urlString) {
  try { await resolveTarget(urlString); return true; } catch { return false; }
}

// Dependencies can be injected in isolated tests; callers use only defaults.
export function createSafeWebsiteFetcher({ lookup = dns.lookup, transports = { 'http:': http, 'https:': https } } = {}) {
  return async function safeFetchWebsite(urlString, maxBytes = 3 * 1024 * 1024, timeoutMs = 10000) {
    let target;
    try { target = await resolveTarget(urlString, lookup); }
    catch { throw new Error('SSRF blocked: website destination is private, forbidden or could not be resolved'); }
    const { url, address } = target;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve(result);
      };
      const req = transports[url.protocol].request(url, {
        method: 'GET',
        headers: { 'User-Agent': 'LeadsyCatalogBot/1.0', Accept: 'application/json, text/xml, application/xml, text/html, */*' },
        lookup: (_host, options, callback) => {
          // Node may request the all-addresses form when family auto-selection is enabled.
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }
      }, response => {
        const status = response.statusCode || 0;
        // Do not follow redirects: the redirect target would need independent validation and pinning.
        if (status < 200 || status >= 300) {
          response.resume();
          finish(null, { ok: false, status, text: '' });
          return;
        }
        if (Number(response.headers['content-length']) > maxBytes) {
          response.destroy();
          finish(new Error(`Response exceeded max limit of ${maxBytes} bytes`));
          return;
        }
        let size = 0;
        const chunks = [];
        response.on('data', chunk => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            finish(new Error(`Response body exceeded max limit of ${maxBytes} bytes`));
          } else chunks.push(chunk);
        });
        response.on('error', err => finish(err));
        response.on('aborted', () => finish(new Error('Response aborted')));
        response.on('end', () => finish(null, { ok: true, status, text: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
      });
      const timer = setTimeout(() => { req.destroy(); finish(new Error('Website fetch timed out')); }, timeoutMs);
      req.on('error', err => finish(err));
      req.end();
    });
  };
}
export const safeFetchWebsite = createSafeWebsiteFetcher();
