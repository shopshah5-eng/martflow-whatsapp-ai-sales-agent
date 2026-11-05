import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSafeWebsiteFetcher, isPublicAddress } from '../src/services/safeWebsiteFetch.js';

function fakeTransport(status, chunks, inspect = () => {}) {
  return { request(url, options, onResponse) {
    inspect(url, options);
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = () => queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = {};
      onResponse(response);
      for (const chunk of chunks) response.write(chunk);
      response.end();
    });
    return req;
  } };
}

test('website fetch pins validated DNS answers and refuses redirects and special IPs', async () => {
  assert.equal(isPublicAddress('::ffff:7f00:1'), false);
  assert.equal(isPublicAddress('fe90::1'), false);
  assert.equal(isPublicAddress('ff02::1'), false);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  let pinned;
  const transport = fakeTransport(200, ['abc'], (url, opts) => opts.lookup(url.hostname, {}, (e, ip, family) => { pinned = [ip, family]; }));
  const fetcher = createSafeWebsiteFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], transports: { 'https:': transport } });
  assert.equal((await fetcher('https://store.example/products')).text, 'abc');
  assert.deepEqual(pinned, ['8.8.8.8', 4]);
  const redirectFetcher = createSafeWebsiteFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], transports: { 'https:': fakeTransport(302, []) } });
  assert.equal((await redirectFetcher('https://store.example')).ok, false);
  const rebinding = createSafeWebsiteFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], transports: { 'https:': transport } });
  await assert.rejects(rebinding('https://store.example'), /SSRF blocked/);
  await assert.rejects(fetcher('https://user:password@store.example'), /SSRF blocked/);
  const oversized = createSafeWebsiteFetcher({ lookup: async () => [{ address: '8.8.8.8', family: 4 }], transports: { 'https:': fakeTransport(200, ['abcd']) } });
  await assert.rejects(oversized('https://store.example', 3), /exceeded/);
});
