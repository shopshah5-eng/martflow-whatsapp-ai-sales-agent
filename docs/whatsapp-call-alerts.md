# Incoming WhatsApp call alerts

When a connected workspace's Baileys socket receives a live, direct incoming WhatsApp voice or video call offer, it sends one informational WhatsApp message to that workspace's configured main/owner alert number. It does not answer, reject, forward, end or otherwise control the call, and does not message the caller. The customer may continue to hear normal ringing until their call ends or the account owner handles it on a supported device. An alert says **incoming**, not missed or answered.

## Configuration and safety

- Set the workspace's **owner alert number** in its WhatsApp settings, including country code; 10-digit Indian mobile numbers are accepted. If absent, the workspace-scoped escalation number in AI settings is used. No global number or another workspace is used as a fallback.
- The recipient must have WhatsApp, the workspace session must be connected, and **owner alerts** must be enabled. `ALERTS_DRY_RUN=true` suppresses sending. Alerts are best effort: an unavailable socket, provider outage, lookup failure or missing number can prevent delivery.
- A verified phone-number JID or `callerPn` is included when available. A WhatsApp LID is not presented as a phone number; when the number cannot be resolved, the alert asks the recipient to check WhatsApp.
- Group calls, offline/stale call offers, updates after the initial offer, and calls from the main number or the linked account are ignored. Events are deduplicated by workspace and call ID for 15 minutes **within one running process**; restarts or multiple workers may duplicate or lose alerts. This is not a durable queue or an exactly-once guarantee.
- This feature handles WhatsApp call events exposed by Baileys, not regular mobile-network calls or guaranteed official Cloud API call events. Delivery and event availability depend on the actual provider and device behavior; no claim of official platform compliance is implied.

## Staging verification before production

Use two explicitly authorized test accounts/numbers. Configure a separate main WhatsApp number, connect the business account, and place a direct WhatsApp call while observing the receiving phone. Check that the main number receives only one informational alert, the caller is not messaged, and the bot neither answers nor rejects the call. Test audio/video, repeated calls, reconnect, two isolated workspaces, unknown caller IDs, disabled alerts, missing destination and temporary database/network failures. Do not use real customer numbers without approval. Keep prior database, storage, account-authorization and conversation-privacy launch blockers in `audit-handoff-2026-11-05.md` on the rollout checklist, including the fact that unsafe owner-number editing could redirect caller details.
