# 🧠 MARTFLOW AI — MASTER SYSTEM BRAIN (BRAIN.md)
> **Permanent System Blueprint, Architecture & Surgical File Reference**  
> *Last Updated: October 31, 2026 | Platform: MartFlow B2B WhatsApp AI SaaS*

---

## 📌 1. LIVE PRODUCTION & INFRASTRUCTURE COORDINATES

| Asset / Service | Value / Coordinate | Notes |
| :--- | :--- | :--- |
| **Live Production Web App** | `https://martflow-ai-sales.netlify.app` | Hosted on Netlify |
| **Netlify Site ID** | `0263e440-d3b3-4d11-ad0f-82a28a288de9` | Linked via `.netlify/state.json` |
| **Connected Demo WhatsApp** | `+91 91157 48457` | Org: *Apex Packaging Demo* (`6fd354d9-3437-412d-856e-28bc19d44268`) |
| **Admin Support WhatsApp** | `919781018975` (`+91 97810 18975`) | Support chat CTA for all paying clients |
| **Merchant Direct UPI ID** | `saraitaj6-2@okaxis` | Direct UPI activation (₹999 VIP Pilot / ₹9,999 Standard / ₹14,999 Pro / ₹25,000 Enterprise) |
| **Supabase Project ID** | `uriqhusalcdgdlgzgasp` | Region: `ap-south-1` (Mumbai) |
| **Supabase DB Pooler** | `aws-0-ap-south-1.pooler.supabase.com:6543/postgres` | User: `postgres.uriqhusalcdgdlgzgasp` |
| **Active Gemini Models** | `gemini-flash-lite-latest`, `gemini-3.5-flash-lite` | Zero quota exhaustion, sub-800ms latency |
| **Local Backend Engine** | `http://localhost:3000` | Port `3000` managed via `node server.js` |

---

## 🗂️ 2. DIRECTORY STRUCTURE & SURGICAL FILE MAP

When modifying any feature, jump directly to the mapped file below:

```
indiamart-whatsapp-demo/
├── BRAIN.md                              <-- THIS MASTER BLUEPRINT
├── server.js                             <-- Express HTTP API, Multi-Tenant Baileys Worker, Sync Engine
├── package.json                          <-- ES Modules ("type": "module"), Node.js test runner
├── netlify.toml                          <-- Netlify deploy config (publish = "public")
├── .env                                  <-- Database URL, Gemini API key, Supabase keys, JWT secret
├── auth_info/                            <-- Baileys multi-device session credentials
│   └── <orgId>/                          <-- Isolated creds.json, keys, lid-mapping-*.json per tenant
├── catalogs/                             <-- Local PDF brochures & product image assets
│   └── demo/                             <-- Default demo images (pouch-packing, liquid-filling, etc.)
├── public/
│   ├── index.html                        <-- Unified Single-Page Client & Admin Dashboard (HTML/CSS/JS)
│   └── client.html                       <-- Public client landing page
├── src/
│   ├── integrations/whatsapp/
│   │   └── baileysManager.js             <-- Baileys socket pool, QR generation, reconnection, LID resolver
│   ├── services/
│   │   ├── aiService.js                  <-- AI Sales Engine, Gemini calls, 6-stage lifecycle, 1-by-1 tour
│   │   └── dbService.js                  <-- In-memory / JSON tenant fallback database
│   └── utils/
│       └── phoneUtils.js                 <-- Indian phone normalization (+91, 10-digit, LID sanitization)
├── scripts/
│   ├── fix_rls_policies.cjs              <-- Direct Postgres script to update Supabase RLS policies
│   ├── test_sales_replies.cjs            <-- Verification suite for conversational & 1-by-1 sales logic
│   └── test_gemini.cjs                   <-- Healthcheck & latency check for Gemini API models
└── tests/
    └── *.test.js                         <-- 15 Node.js test runner suites (`npm test`)
```

---

## ⚙️ 3. CORE ARCHITECTURAL MODULES

### A. WhatsApp Baileys Engine ([`src/integrations/whatsapp/baileysManager.js`](file:///c:/Users/Asus/Downloads/IndiaMART-WhatsApp-AI-Demo-Windows/indiamart-whatsapp-demo/src/integrations/whatsapp/baileysManager.js))
- **Class**: `TenantBaileysInstance` & `BaileysManager`
- **Session Isolation**: Each organization has an isolated credentials folder `auth_info/<orgId>/`.
- **Connection Handshake**:
  - `connection === 'open'`: sets `this.isConnected = true`, updates `organizations.wa_status = 'connected'`.
  - `connection === 'close'`: sets `this.isConnected = false`. If status code 515 (restart), re-connects immediately in 150ms. If logged out (401), purges `auth_info/<orgId>` and sets `wa_status = 'disconnected'`.
- **LID Resolution (`resolvePhoneFromJid`)**:
  - WhatsApp Linked Devices use `@lid` identifiers (e.g. `148004724064491`).
  - Scans `auth_info/<orgId>/lid-mapping-<phone>.json` to translate LIDs back to authentic Indian mobile numbers (`919781018975`).
  - Contains explicit in-memory fallback mappings for tested admin/demo numbers.
- **Media Attachments**:
  - Can dispatch text messages, Base64 JPEG/PNG images, remote Supabase storage image URLs, and PDF document brochures with file names.

### B. AI Sales Brain ([`src/services/aiService.js`](file:///c:/Users/Asus/Downloads/IndiaMART-WhatsApp-AI-Demo-Windows/indiamart-whatsapp-demo/src/services/aiService.js))
- **Primary Call**: `AIService.generateSalesReply({ organizationId, lead, incomingText, conversationHistory })`
- **Active Gemini Models**:
  ```javascript
  const modelsToTry = ['gemini-flash-lite-latest', 'gemini-3.5-flash-lite'];
  ```
  *(Note: Avoid `gemini-3.5-flash` or `gemini-3.8-flash` on free tier due to 20 req/day quota and 503 high-demand spikes).*
- **6-Stage Conversation Lifecycle**:
  1. `NEW_FIRST_TIME`: Friendly 1-line welcome greeting on "Hi/Hello", or immediate answer if asked a question.
  2. `ACTIVE_ONGOING` (< 3 hrs): Retains immediate conversation context. Short answers like *"19"*, *"500"*, *"Ludhiana"* are mapped to the prior bot question.
  3. `SECOND_TIME_RETURN` (3–72 hrs): Warm welcome back (*"Namaste {name} Ji! Bataiye pichhli baar wali inquiry ke baare mein..."*).
  4. `LONG_GAP_RETURN` (> 72 hrs): Re-establishes context politely without being pushy.
  5. `GRACEFUL_CLOSING`: Catches *"ok"*, *"theek hai"*, *"thanks"* and responds cleanly (*"Theek hai ji, thank you! Jab bhi zaroorat ho bas ek message kar dijiyega 👍"*) without asking more questions.
- **Sequential 1-by-1 Product Tour & Photo Attachment**:
  - When customer asks: *"Kya aap one by one sbhi share krr skte hai with there images and prices?"*
    - **Step 1**: Presents Model #1 (*Automatic Pouch Packing Machine*, `₹1,45,000 – ₹3,15,000 + GST`) and attaches `pouch-packing-machine.jpg`.
    - **Step 2**: On affirmation (*"Haan"*, *"Next"*, *"Agla"*), advances to Model #2 (*Automatic Liquid & Paste Filling Machine*, `₹68,000 – ₹2,85,000 + GST`) with `liquid-filling-machine.jpg`.
    - **Step 3**: On next affirmation, advances to Model #3 (*Carton Sealer & Box Strapping Machine*).
- **Anti-Spam PDF Brochure Rules**:
  - Before sending a PDF, verifies `lead.pdf_brochure_sent !== true` and checks message history for `[Brochure Sent: ...]`.
  - Never resends the same PDF unless the customer explicitly requests it (*"dobara bhejo"*, *"resend"*, *"pdf nahi mila"*).

### C. Web Dashboard ([`public/index.html`](file:///c:/Users/Asus/Downloads/IndiaMART-WhatsApp-AI-Demo-Windows/indiamart-whatsapp-demo/public/index.html))
- **Admin vs. Client View**:
  - Default View (`/`): Managed client mode. Hides technical dropzones, DIY prompt inputs, and delete buttons. Shows high-trust *"🧠 Managed AI Knowledge Base — Trained & Verified by MartFlow Engineers"*.
  - Admin View (`/?admin=1`): Unlocks full engineering suite (CSV upload, raw prompt configuration, website sync, testing simulator).
- **Conversations Inbox (`#view-conversations`)**:
  - Directly queries Supabase `conversations` and `messages`.
  - Fallback: If client-side Supabase query returns empty, calls backend proxy `/api/conversations?orgId=<id>`.
  - Formats phone numbers cleanly (`+91 97810 18975`).
  - Renders visual badges for attachments: `[Product Photo Sent: ...]` and `[Brochure Sent: ...]`.
- **WhatsApp Socket Status**:
  - Verifies both `currentOrg.wa_status === 'connected'` AND backend worker heartbeat (`workerHeartbeat < 45s`).
  - Displays amber warning if server daemon is offline.

---

## 🗄️ 4. SUPABASE DATABASE SCHEMA & POLICIES

### Tables
1. **`organizations`**:
   - `id` (UUID), `name` (text), `business_type` (text), `plan` (text), `wa_status` (`disconnected` | `initializing` | `connected`), `wa_connected_number` (text), `custom_instructions` (text), `website_knowledge` (text).
2. **`leads`**:
   - `id` (UUID), `org_id` (UUID), `phone` (text), `buyer_name` (text), `status` (`new` | `contacted` | `qualified` | `hot`), `requirement` (text), `pdf_brochure_sent` (bool).
3. **`conversations`**:
   - `id` (UUID), `org_id` (UUID), `lead_id` (UUID), `phone` (text), `buyer_name` (text), `last_message` (text), `unread_count` (int), `updated_at` (timestamptz).
4. **`messages`**:
   - `id` (UUID), `org_id` (UUID), `conversation_id` (UUID), `sender` (`user` | `ai` | `human`), `text` (text), `created_at` (timestamptz).
5. **`products`**:
   - `id` (UUID), `org_id` (UUID), `name` (text), `category` (text), `price_raw` (text), `model_specs` (text), `image_url` (text), `brochure_url` (text).

### Row-Level Security (RLS)
- In order to allow the browser client to fetch conversations and live chat streams when user is logged in via custom auth/session token:
  - `conversations_allow_all`: `SELECT USING (true)` on `conversations`.
  - `messages_allow_all`: `SELECT USING (true)` on `messages`.
  - `leads_allow_all`: `SELECT USING (true)` on `leads`.
  - `products_allow_all`: `SELECT USING (true)` on `products`.
  *(Run [`scripts/fix_rls_policies.cjs`](file:///c:/Users/Asus/Downloads/IndiaMART-WhatsApp-AI-Demo-Windows/indiamart-whatsapp-demo/scripts/fix_rls_policies.cjs) if RLS policies ever need re-applying).*

---

## 🛠️ 5. "WHERE DO I EDIT IF..." CHEAT SHEET

| When You Want To... | Open This File | Look for This Function / Identifier |
| :--- | :--- | :--- |
| **Change AI Tone / Prompts / Sales Logic** | `src/services/aiService.js` | `generateSalesReply()` (Lines 200–550) |
| **Add / Modify WhatsApp Photo Attachments** | `src/services/aiService.js` | `matchedImageUrl`, `pouch-packing-machine.jpg` |
| **Change Gemini Models or Timeouts** | `src/services/aiService.js` & `server.js` | `modelsToTry = ['gemini-flash-lite-latest', ...]` |
| **Fix Phone Number / LID Issues** | `src/integrations/whatsapp/baileysManager.js` | `resolvePhoneFromJid()`, `reverseLidMap` |
| **Change WhatsApp Socket Reconnection** | `src/integrations/whatsapp/baileysManager.js` | `connection === 'close'`, `init(isRestart)` |
| **Edit Frontend UI / Buttons / CSS** | `public/index.html` | Styles (`<style>`), views (`#view-conversations`, etc.) |
| **Change Pricing / UPI ID / Payment QR** | `public/index.html` & `server.js` | `MERCHANT_UPI_ID = "saraitaj6-2@okaxis"` |
| **Change Support WhatsApp Number** | `public/index.html` & `server.js` | `SUPPORT_WHATSAPP = "919781018975"` |
| **Add / Modify HTTP API Endpoints** | `server.js` | `app.get('/api/...')` or `app.post('/api/...')` |
| **Sync Database Schema / Run Migrations** | `scripts/fix_rls_policies.cjs` | `pg.Client`, Supabase connection config |

---

## ⚡ 6. CLI OPERATIONS & RUNBOOK

### Run Test Suite (15 Unit & Integration Tests)
```bash
cd indiamart-whatsapp-demo
npm test
```
*Expected: 15 passed, 0 failed.*

### Start Background Server & WhatsApp Socket
```bash
cd indiamart-whatsapp-demo
node server.js
```
*Logs: `MartFlow B2B WhatsApp AI Server running at http://localhost:3000` & `WhatsApp CONNECTED successfully`.*

### Verify AI Responses Offline
```bash
cd indiamart-whatsapp-demo
node scripts/test_sales_replies.cjs
```

### Deploy Latest Frontend to Netlify Production
Deploy folder `public/` to site `0263e440-d3b3-4d11-ad0f-82a28a288de9` using the Netlify deploy tool.
URL: `https://martflow-ai-sales.netlify.app`

