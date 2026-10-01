# Tweet suggestions through Discord

The backend schedules evidence-backed tweet drafts. This bot delivers one review DM per stored draft and sends signed review requests through the existing jobs API tunnel. It never holds Twitter credentials or changes approved text.

The integration is **disabled by default**. Implementing it does not activate schedules, send DMs or publish tweets.

## Configure

Provision a separate jobs API HMAC key with only `social:read` and `social:review` scopes. Do not reuse the builds producer credential. The backend reviewer must match the bot reviewer.

```dotenv
SOCIAL_SUGGESTIONS_ENABLED=false
SOCIAL_REVIEWER_DISCORD_ID=709042878592057406
JOB_API_BASE_URL=https://jobs.egdata.app
JOB_API_KEY_ID=discord-social
JOB_API_SECRET=<dedicated secret of at least 32 characters>
SOCIAL_JOURNAL_PATH=/persistent-data/social-suggestions.jsonl
SOCIAL_POLL_INTERVAL_MS=60000
# Only when the tunnel's Cloudflare Access policy requires a service token:
# CF_ACCESS_CLIENT_ID=<service token ID>
# CF_ACCESS_CLIENT_SECRET=<service token secret>
```

The reviewer's Discord ID defaults to `709042878592057406`; the override is optional. HTTPS is required except for loopback development. Keep the API private behind the authenticated Cloudflare tunnel. Cloudflare Access tokens, if used, supplement the HMAC signature.

Mount the journal directory on durable storage. Run exactly one bot instance against the journal. The `.lock` file prevents concurrent writers. Every delivery intent, message binding and review intent is written and fsynced before the corresponding side effect. Protect the journal as private data: it contains drafts, evidence and Discord IDs, but no credentials. Back up the journal with the bot stopped; do not delete it as routine cleanup.

Enable the backend draft job and this feature only as a deliberate deployment action. The Discord client includes direct-message reaction intents and reaction partials for recovery after restarts. The reviewer must allow bot DMs.

## Review

Each DM shows the stored tweet verbatim, rationale, evidence, expiry and current publication state. Evidence labels are escaped and mentions are disabled. Cards stay within Discord's field and total-text limits; any source that cannot fit is counted in an explicit omitted-source notice. The complete evidence remains stored in the backend suggestion.

- ✅ submits approval for the exact ID, version, recipient and Discord message binding.
- ❌ rejects the suggestion.
- 🔄 rejects the prior suggestion and requests a replacement from the backend; a new draft arrives as a separate DM.

Only the configured human reviewer can submit an action. The first action is durable; adding other reactions during a retry cannot change it. Removing a reaction does not undo a submitted review or cancel a publication. The backend validates freshness and facts again before publication. Stale and expired suggestions cannot be approved.

Approval shows “Publishing” until the backend confirms `published`. `publication_unknown` means the backend must reconcile the tweet request; the bot never re-submits a new publication to resolve that state.

Polling resumes reviews after network failures, using fresh signing nonces and stable mutation idempotency keys. It also recovers reactions left while the bot was offline. If multiple approval-action reactions were left offline, it waits until only one remains.

## Delivery recovery

Discord sending and journal persistence cannot form a single transaction. The bot records an `unknown` delivery intent before sending, uses a stable Discord nonce with nonce enforcement, and **does not automatically resend** an uncertain delivery. It searches the reviewer's most recent 100 DMs for one exact bot-authored message matching the draft text and version marker. Backend-persisted bindings also restore messages if the local journal is recovered or moved.

If the message is absent from this bounded search, the suggestion stays held and logs `Social DM delivery unknown`. An operator must verify Discord history and reconcile the backend delivery binding with the exact message ID/channel ID. Do not erase the intent and resend without establishing that no DM was delivered. Discord edits or mismatched stored draft text also hold the suggestion.

A clean SIGINT/SIGTERM stops polling, aborts jobs API requests, drains started work and releases the writer lock. After an unclean stop, first verify that the prior process is gone before removing only the journal's `.lock` file. Preserve the journal itself. An incomplete final journal record causes a fail-closed startup; recover it from a backup or inspect the trailing write and treat its delivery/review outcome as uncertain before repair.

## Credential-free checks

```powershell
pnpm build
pnpm test:social
```

Tests use mock Discord and HTTP transports. They cover signer compatibility, authorization, exact draft/version binding, ambiguous delivery, offline reactions, durable retries, journal recovery and publication-state display without contacting Discord, Cloudflare, Temporal or Twitter.
