# Owner notification filtering

The WhatsApp owner number should not receive an alert for every new conversation. The tenant WhatsApp handler now continues its normal buyer conversation and lead handling, but only sends an owner notification when buyer-written text indicates:

- an explicit request to speak to a person or receive a call; or
- a direct purchase/booking commitment; or
- a commercial interest signal together with a useful quantity, budget or timing signal, including across recent messages.

A greeting, standalone price question, catalogue request or untranscribed voice note alone does not trigger the owner alert. One-piece enquiries are not discarded: retail and service customers can still express real intent. Human takeover relay messages and incoming WhatsApp call alerts are separate from this filter; call alerts must never answer or reject a call. The workspace's `wa_owner_alerts === false` suppresses these automatic lead notifications.

Buyer and human-request notifications use separate 30-minute cooldowns per workspace and full normalized phone, so a subsequent explicit handoff is not lost in the buyer-alert cooldown. A failed or dry-run send is not recorded as delivered. The old unconditional new-lead, voice-as-hot, AI-reply-based stock/discount, and duplicate order notifications are no longer sent by the tenant handler. AI-generated text is not treated as evidence of buyer intent.

This is a rule-based approximation, **not proof** that someone will buy. It may miss genuine buyers who do not give recognizable details, and it may still alert for non-buyers. Review the inbox for unalerted conversations. The rules cover selected English, Hindi and Hinglish phrases, not every language or industry. Captions with buyer-written text can qualify; voice/audio without a transcript cannot. No claim is made that voice transcription is implemented here.

Only coarse interest/detail flags are retained in process memory, keyed by workspace and the entire normalized phone; entries expire after two hours and the map is bounded. State does not survive restarts or span multiple workers. The existing alert database read/write is not an atomic claim, so concurrent instances can duplicate or miss alerts, especially after database failures. Existing legacy phone-matching and takeover paths elsewhere still require the migration described in `comprehensive-audit-handoff-2026-11-05.md`. Validate classification, concurrency, tenant isolation, the selected phone number and real provider delivery with synthetic staging accounts and explicitly approved test numbers before rollout; no real message or production deployment was performed for this change.
