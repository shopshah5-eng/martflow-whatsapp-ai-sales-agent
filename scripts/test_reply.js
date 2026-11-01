import { AIService } from '../src/services/aiService.js';
import dotenv from 'dotenv';
dotenv.config();

async function testPrompt() {
  const result = await AIService.generateSalesReply({
    organizationId: '6fd354d9-3437-412d-856e-28bc19d44268',
    lead: { buyer_name: 'Taj', buyer_phone: '919781018975' },
    incomingText: 'Kya aap one by one sbhi share krr skte hai with there images and prices?',
    conversationHistory: [
      { sender: 'ai', text: 'Catalog mein humari main categories hain: Automatic Pouch Packing Machines (₹1.5 lakh se shuru), Carton Sealing Machines, aur Strapping Machines. Aapko kis specific category ke baare mein detail aur exact pricing janni hai?' }
    ]
  });
  console.log('RESULT:', result);
}
testPrompt();
