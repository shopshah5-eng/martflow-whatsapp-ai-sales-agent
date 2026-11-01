const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();

const key = process.env.GEMINI_API_KEY;
const candidates = [
  'gemini-flash-lite-latest',
  'gemini-3.1-flash-lite',
  'gemini-3.5-flash-lite',
  'gemini-3.7-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it'
];

(async () => {
  for (const m of candidates) {
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(6000),
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Say hi in 1 word' }] }] })
      });
      console.log(m, 'status:', resp.status);
      if (resp.ok) {
        const d = await resp.json();
        console.log(m, 'SUCCESS:', d?.candidates?.[0]?.content?.parts?.[0]?.text?.trim());
      } else {
        const err = await resp.json();
        console.log(m, 'error message:', err?.error?.message?.slice(0, 80));
      }
    } catch (e) {
      console.log(m, 'exception:', e.message);
    }
  }
})();
