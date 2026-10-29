# 🚀 Autonomous IndiaMART B2B WhatsApp Sales & Deal Closing Agent

> **Turn Raw IndiaMART Machinery Leads into Closed Deals on WhatsApp in Under 10 Seconds.**  
> Powered by Google Gemini AI, Baileys WhatsApp Multi-Device Protocol, Opus OGG Voice Synthesizer, and Dynamic Multi-Format Catalog Intelligence.

---

## 🌟 Executive Summary

In high-ticket B2B manufacturing and machinery, **speed to lead is the entire game**. When a buyer submits an inquiry on IndiaMART or JustDial, the first supplier to respond with technical clarity, product brochures, and professional follow-up captures the deal.

This system replaces slow manual callbacks with an **Autonomous 24/7 AI Sales Representative** that operates directly on your official WhatsApp Business number.

---

## ⚡ Core Capabilities

### 1. ⚡ Sub-10 Second Instant Engagement
- Captures IndiaMART leads via webhook or simulated dry-run.
- Automatically dispatches the matching product PDF brochure to the buyer's WhatsApp within 10 seconds.
- Greets the buyer with warm, professional Hinglish etiquette (`"Namaste Ji! Bharat PackTech Machinery se baat kar rahe hain..."`).

### 2. 🎙️ Native Opus OGG Voice Notes (On-Demand)
- Speaks real conversational Hindi/Hinglish voice notes directly inside WhatsApp.
- Encoded in native **48 kHz Mono Opus in Ogg container (`audio/ogg; codecs=opus`)** for instant native in-app playback with voice waveforms on iOS and Android.
- **On-Demand Intelligence**: Only sends audio when the customer explicitly asks for voice or sends an audio message, keeping communication respectful and non-intrusive.

### 3. 📑 Multi-Format Catalog Knowledge Engine
- Clients can upload product catalogs in **PDF, Excel (`.xlsx`, `.xls`), or CSV**.
- Automatically indexes product specifications, batch capacities, motor horsepowers, and price brackets.
- The AI quotes strictly from verified catalog specs with **zero hallucination**.

### 4. 🤝 2-Way Factory Owner Call Booking Engine
- When a buyer requests a technical phone consultation:
  1. The agent messages the factory owner on WhatsApp: *"Buyer wants a call for Ribbon Blender. When are you free?"*
  2. The owner replies naturally (e.g., *"Aaj shaam ko 5 baje"* or *"Tomorrow after 11 AM"*).
  3. AI extracts the confirmed time slot, notifies the buyer with confirmation, and alerts the owner with a **1-tap WhatsApp call link**.

### 5. 👤 Strict Customer Identity (No Fake Names)
- Strictly avoids assumed default names.
- Uses respectful neutral greetings (`"Namaste Ji!"`, `"Ji Sir"`) until the customer explicitly shares their name (`"Mera naam Sandeep hai"` ➔ greeted as `"Namaste Sandeep Ji!"`).

### 6. 📊 Dual Control Dashboards
- **Executive Control Room (`/index.html`)**: Real-time WhatsApp connection status, live QR code scanner, lead tracker, prompt inspector, and manual dry-run launcher.
- **Client Portal (`/client.html`)**: Client-facing portal for instant catalog uploads, seller profile configuration, and call schedule management.

---

## 🏗️ Architecture

```
                      ┌──────────────────────────────────────┐
                      │    IndiaMART / Marketplace Webhook   │
                      └──────────────────┬───────────────────┘
                                         │ Lead Payload (<10s)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                          Node.js Express Application                            │
│                                                                                 │
│   ┌────────────────────┐   ┌─────────────────────┐   ┌──────────────────────┐   │
│   │  Catalog Ingestion │   │   Gemini 2.5 Flash  │   │  Opus OGG Voice Engine│  │
│   │  (PDF, XLSX, CSV)  │   │  Hinglish Deal Maker│   │ (FFmpeg 48kHz Mono)  │   │
│   └─────────┬──────────┘   └──────────┬──────────┘   └──────────┬───────────┘   │
│             │                         │                         │               │
│             └─────────────────────────┼─────────────────────────┘               │
│                                       ▼                                         │
│                      ┌─────────────────────────────────┐                        │
│                      │ Baileys WhatsApp Multi-Device   │                        │
│                      │ Persistent WebSocket Connection │                        │
│                      └────────────────┬────────────────┘                        │
└───────────────────────────────────────┼─────────────────────────────────────────┘
                                        │ WhatsApp Multi-Device (wss://)
                                        ▼
                  ┌─────────────────────────────────────────────┐
                  │               WhatsApp Network              │
                  ├──────────────────────┬──────────────────────┤
                  │                      │                      │
                  ▼                      ▼                      ▼
        ┌──────────────────┐   ┌───────────────────┐  ┌───────────────────┐
        │  Customer Phone  │   │   PDF Brochure    │  │  Factory Owner    │
        │ (Hinglish Audio/ │   │   Attachment      │  │ (Call Scheduling  │
        │      Text)       │   │                   │  │    Alerts)        │
        └──────────────────┘   └───────────────────┘  └───────────────────┘
```

---

## 🚀 Quick Start (Local Setup)

### Prerequisites
- Node.js >= 20.0.0
- Google Gemini API Key ([Get a free key at Google AI Studio](https://aistudio.google.com/))
- WhatsApp account (Personal or Business)

### 1. Clone & Install
```bash
git clone https://github.com/shopshah5-eng/indiamart-whatsapp-ai-sales-agent.git
cd indiamart-whatsapp-ai-sales-agent
npm install
```

### 2. Configure Environment
Create a `.env` file from `.env.example`:
```bash
cp .env.example .env
```
Fill in your credentials:
```env
PORT=3000
GEMINI_API_KEY=your_gemini_api_key_here
OWNER_ALERT_PHONE=919876543210
```

### 3. Start the Server
```bash
npm start
```

### 4. Link WhatsApp
1. Open `http://localhost:3000` in your browser.
2. Scan the displayed QR Code with WhatsApp (**Linked Devices > Link a Device**).
3. Once connected, your AI Sales Agent is live!

---

## 🌐 Cloud Deployment

### A. Frontend Dashboard on Netlify
The static dashboards in `public/` can be served directly via Netlify:
1. Connect this repository to **Netlify**.
2. Set Publish directory to `public`.
3. Configuration is automatically detected via `netlify.toml`.

### B. Backend WhatsApp Daemon (Render / Railway / VPS / Docker)
Because WhatsApp multi-device (Baileys) maintains a stateful 24/7 WebSocket connection, the backend requires a persistent container:

#### 1-Click Render Deploy
- Uses included `render.yaml`.
- Set Environment Variable `GEMINI_API_KEY`.
- Connects automatically and persists your WhatsApp session.

#### Docker
```bash
docker build -t indiamart-whatsapp-agent .
docker run -p 3000:3000 -v $(pwd)/auth_info:/app/auth_info indiamart-whatsapp-agent
```

---

## 🔒 Security & Privacy

- **Zero Credential Leakage**: Multi-device session keys (`auth_info/`) are stored locally and are strictly excluded via `.gitignore`.
- **API Keys**: Loaded securely from environment variables.
- **Catalog Isolation**: Uploaded client catalogs are processed and stored in sandboxed storage.

---

## 📄 License
MIT License. Built for modern high-intent B2B machinery and manufacturing suppliers.
