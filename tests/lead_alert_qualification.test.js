import test from 'node:test';
import assert from 'node:assert/strict';
import { createLeadAlertQualifier } from '../src/services/leadAlertQualification.js';

const event = (text, orgId = 'org-a', phone = '919111111111') => ({ orgId, phone, text });

test('greetings, isolated price questions, media, and negation do not alert', () => {
  for (const text of ['hi','hello','good morning','price?','rate kya hai?','catalogue please','', 'not interested in ordering 20 pieces', 'do not call me', 'call mat karo', 'stop', 'just browsing']) {
    const q = createLeadAlertQualifier();
    assert.equal(q.evaluate(event(text)).shouldAlert, false, text);
  }
});

test('buying signals accumulate across turns and remain tenant and buyer isolated', () => {
  const q = createLeadAlertQualifier();
  assert.equal(q.evaluate(event('hi')).shouldAlert, false);
  assert.equal(q.evaluate(event('What is the price?')).shouldAlert, false);
  assert.equal(q.evaluate(event('hello')).shouldAlert, false);
  assert.equal(q.evaluate(event('I need 5 pieces','org-b')).shouldAlert, true);
  assert.equal(q.evaluate(event('5 pieces','org-b','919222222222')).shouldAlert, false);
  const result = q.evaluate(event('5 pieces'));
  assert.equal(result.reason, 'interest_with_details');
  assert.equal(q.evaluate(event('thanks')).shouldAlert, false);
});

test('buying commitment and explicit human requests alert without requiring large quantities', () => {
  for (const text of ['I want to order one item','order karna hai','please book an appointment','I want to buy this','call me please','I need a real person','I want to speak to someone','मालिक से बात करनी है']) {
    const q = createLeadAlertQualifier();
    assert.equal(q.evaluate(event(text)).shouldAlert, true, text);
  }
  assert.equal(createLeadAlertQualifier().evaluate(event('please call me')).reason, 'human_request');
  assert.equal(createLeadAlertQualifier().evaluate(event('Price for 10 machines?')).reason, 'interest_with_details');
});

test('clear, opt-out, expiry and capacity do not reuse stale qualification signals', () => {
  let clock = 1;
  const q = createLeadAlertQualifier({ ttlMs: 100, maxEntries: 1, now: () => clock });
  q.evaluate(event('price?'));
  q.evaluate(event('not interested'));
  assert.equal(q.evaluate(event('10 pieces')).shouldAlert, false);
  q.evaluate(event('price?')); q.evaluate(event('reset'));
  assert.equal(q.evaluate(event('10 pieces')).shouldAlert, false);
  q.clear(); q.evaluate(event('price?')); clock += 100;
  assert.equal(q.evaluate(event('10 pieces')).shouldAlert, false);
  q.clear(); q.evaluate(event('price?')); q.evaluate(event('price?', 'org-b'));
  assert.equal(q.evaluate(event('10 pieces')).shouldAlert, false);
});
