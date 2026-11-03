import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import apiRouter from '../src/routes/api.js';
import db from '../src/db/index.js';

test('public demo never writes an enquiry into an unrelated first tenant', async () => {
  // No disk writes or real accounts: this file runs in its own test process.
  db.tables.organizations = new Map([['other-org', { id: 'other-org', name: 'Other tenant' }]]);
  db.tables.leads = new Map();
  db.persist = () => {};
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/public/demo-enquiry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Test', phone: '9876543210' })
    });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
    assert.equal(db.tables.leads.size, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
