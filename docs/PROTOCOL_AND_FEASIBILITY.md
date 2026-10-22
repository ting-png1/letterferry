# Protocol and feasibility notes

Research date: 2026-10-16. Upstream examined: Tencent/openclaw-weixin public `main`, package version 2.4.10. This is a source-derived compatibility implementation, not proof that Tencent will authorize this adapter or that a real account will work.

Primary sources:

- https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md
- https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/api/api.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/api/types.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/inbound.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/messaging/process-message.ts
- https://github.com/Tencent/openclaw-weixin/blob/main/src/monitor/monitor.ts

## Implemented public protocol

- QR creation is the fixed `POST https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3` with `{"local_token_list":[]}`. The lab does not reuse or disclose prior tokens.
- QR status is `GET /ilink/bot/get_qrcode_status` with encoded `qrcode` and, only after a foreground prompt, `verify_code`. Recognized states are `wait`, `scaned`, `need_verifycode`, `scaned_but_redirect`, `expired`, `verify_code_blocked`, `confirmed`, and `binded_redirect`.
- One login session has a five-minute client TTL. Each status request is capped at 35 seconds. Expired and blocked states stop; there are no automatic refresh loops.
- `confirmed` must include nonempty `bot_token`, `ilink_bot_id`, `ilink_user_id`, and an allowed HTTPS `baseurl` before credentials are atomically created. `binded_redirect` is treated as already connected but never fabricates or overwrites credentials.
- `getupdates` posts the prior `get_updates_buf` plus `base_info`. Missing/null `msgs` is an empty list. A missing/null/empty cursor preserves the prior cursor; only a nonempty string is staged for advancement. Wrong message or cursor types fail closed. The staged cursor is protected with the auth record and committed after adapter ingestion succeeds, so restart may duplicate but does not knowingly skip an unpersisted allowed item.
- `sendmessage` carries a stable adapter `client_id`, exact target, bot message type/state, text item, and original inbound `context_token`. HTTP failure, timeout, and nonzero `ret` fail. The public client does not treat an absent `ret` as a business error, so this implementation follows that observed behavior without claiming a stronger server guarantee.
- The wire parser preserves `message_id`, `msg_id`, and `svr_id` uint64 values as strings before JavaScript JSON number coercion. Inbound message identity uses the official priority: trimmed top-level `message_id`, then the first nonempty `item_list[].msg_id`; a numeric value that bypassed the lossless wire parser is rejected rather than risking IEEE-754 corruption.

## Headers and URL boundary

Bot POSTs carry `Content-Type: application/json`, `AuthorizationType: ilink_bot_token`, `Authorization: Bearer <token>`, random uint32 decimal text encoded as base64 in `X-WECHAT-UIN`, `iLink-App-Id: bot`, and version 2.4.10 packed as `0x00MMNNPP`. `base_info` declares protocol channel version 2.4.10 and `LetterFerry/0.4.3` as the observational bot agent. QR status GETs carry only the documented app headers.

Fetch redirects are rejected. Initial QR traffic uses the fixed origin. Returned API base URLs and `scaned_but_redirect` hosts must be HTTPS, have no credentials/port/path/query/fragment, and be either the fixed host or a subdomain of `weixin.qq.com`. This narrow allowlist may reject a legitimate future Tencent host; that is an intentional fail-closed limitation pending public evidence.

## Identity, storage, and runtime gates

The confirmed `ilink_user_id` says who scanned, not that it is equal to message `from_user_id`. Official inbound conversion and route selection use `from_user_id` as the direct peer and do not require `session_id`; this lab therefore stores one canonical `{userId, chatId}` where both values equal the challenge-verified `from_user_id`. Optional or changing `session_id` is never an identity input.

The foreground-only pairing command generates a 192-bit random challenge and watches at most three minutes/six authenticated polls. It matches only the exact full sole text item of a user DM. Missing `message_state`, `NEW` (`0`), and `FINISH` (`2`) are accepted; `GENERATING` (`1`) and unknown states are not. Missing `message_type` or `USER` (`1`) are accepted under the upstream optional-field contract; `BOT` (`2`) and unknown types are rejected. Groups are always rejected. An explicit `to_user_id` must equal the authenticated Bot; a missing target is acceptable only in this authenticated getupdates stream with the high-entropy one-time challenge. Per-poll foreground diagnostics contain counts and fixed rejection labels only. Other payloads remain memory-only and are not logged; competing matching senders fail closed. After one confirmation poll and a nonempty advanced cursor, it writes the binding with both capability flags false. The discovery cursor is committed before the binding, so messages deliberately ignored during a successful pairing window cannot later enter adapter persistence.

Real adapter `getupdates` remains inaccessible until that binding, `inboundEnabled: true`, and the one-cycle approval literal are all present. Real sends additionally require `outboundEnabled: true`, and the transport rechecks the exact peer.

Windows stores the whole auth record with DPAPI CurrentUser through built-in PowerShell/.NET by default. The token and plaintext auth JSON are passed over child-process stdin/stdout rather than command arguments. An explicitly supplied 64-hex `RIVEN_WEIXIN_AUTH_KEY` selects a fail-closed AES-256-GCM fallback for user contexts where DPAPI is unavailable. The ignored `data/weixin-auth.protected` is create-once. Context tokens remain separately AES-256-GCM sealed in the existing adapter database. The sole added runtime package is the locked `qrcode-terminal` 0.12.0 renderer; it receives QR content locally and performs no network operation.

No payloads, tokens, authorization headers, QR values, QR URLs, pairing identities, verification codes, context tokens, or unrelated messages are logged. The CLI emits QR/challenge material only to the explicitly invoked local TTY, plus minimal status text and aggregate cycle results.

## Remaining live gates

Offline tests establish request construction, pairing filters, terminal QR rendering, storage transitions, and failure handling only. Before calling this live-ready, the owner must explicitly approve and personally perform: account/terms eligibility confirmation, QR consent, challenge pairing, local binding review, one inbound-only cycle, existing Fixed Listener routing validation, and a separate harmless outbound cycle. Unknown server-side delivery semantics remain unknown; `OUTBOUND_UNKNOWN` always requires manual reconciliation and is never automatically retried.
