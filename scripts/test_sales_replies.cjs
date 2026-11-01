const dns = require('node:dns');
dns.setDefaultResultOrder('ipv4first');
require('dotenv').config();

async function test() {
  const { AIService } = await import('../src/services/aiService.js');

  const mockOrgId = '6fd354d9-3437-412d-856e-28bc19d44268';
  const mockLead = {
    name: 'Taj',
    phone: '919781018975'
  };

  const cases = [
    { text: 'Who are you', history: [] },
    { text: 'Kaise hai app', history: [] },
    { text: 'Kya aap one by one sbhi share krr skte hai with there images and prices?', history: [] },
    { text: 'Haan agla dikhao', history: [{ sender: 'ai', content: 'sabse pehle humari best-selling Automatic Pouch Packing Machine' }] },
    { text: 'App sbhi ka bta dejiye', history: [] }
  ];

  for (const c of cases) {
    console.log('\n========================================');
    console.log('INPUT:', c.text);
    const result = await AIService.generateSalesReply({
      organizationId: mockOrgId,
      lead: mockLead,
      incomingText: c.text,
      conversationHistory: c.history
    });
    console.log('PROVIDER:', result.provider);
    console.log('IMAGE:', result.matchedImageUrl || 'None');
    console.log('REPLY:\n' + result.reply);
  }
}

test().catch(console.error);

