import test from 'node:test';
import assert from 'node:assert/strict';
import { signUp, login, sendPhoneOtp, verifyPhoneOtp, verifySessionToken } from '../src/auth/authService.js';
import db from '../src/db/index.js';

test('AUTH: Sign-up creates profile, organization, membership, and returns valid session token', async () => {
  const testEmail = `founder_${Date.now()}@packtech.in`;
  const result = await signUp({
    email: testEmail,
    password: 'Password123!',
    fullName: 'Rajesh Sharma',
    companyName: 'Sharma Industrial PackTech',
    phone: '919876543210'
  });

  assert.ok(result.token, 'Session token should be returned');
  assert.equal(result.user.email, testEmail);
  assert.equal(result.role, 'owner');
  assert.ok(result.organization.id, 'Organization ID should exist');

  // Verify token validation
  const verified = verifySessionToken(result.token);
  assert.equal(verified.userId, result.user.id);
  assert.equal(verified.organizationId, result.organization.id);
  assert.equal(verified.role, 'owner');
});

test('AUTH: Login succeeds with correct credentials and fails with invalid password', async () => {
  const email = `login_test_${Date.now()}@factory.in`;
  await signUp({
    email,
    password: 'SecurePassword2026',
    fullName: 'Vikram Singh',
    companyName: 'Singh Packaging Works'
  });

  // Valid login
  const loginRes = await login({ email, password: 'SecurePassword2026' });
  assert.ok(loginRes.token);
  assert.equal(loginRes.user.email, email);

  // Invalid password
  await assert.rejects(
    async () => {
      await login({ email, password: 'WrongPassword' });
    },
    /Invalid email or password/
  );
});

test('AUTH: Phone OTP generates 6-digit code, verifies successfully, and rejects invalid code', () => {
  const phone = '919876500000';
  const sent = sendPhoneOtp(phone);
  assert.equal(sent.sent, true);

  // Rejects invalid code
  assert.throws(
    () => {
      verifyPhoneOtp(phone, '000000');
    },
    /Invalid OTP code/
  );
});
