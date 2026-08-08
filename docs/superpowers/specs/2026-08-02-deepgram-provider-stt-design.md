# Deepgram Provider and Speech-to-Text Design

Date: 2026-08-02

## Scope

Prompts 17 and 18 add Deepgram as a first-class provider without widening the
generic LLM provider contract. Deepgram remains a voice provider (streaming
speech-to-text and Aura text-to-speech), with one canonical desktop credential
stored in the existing OS credential vault.

## Credential boundary

- Canonical credential identifier: `deepgram`.
- Legacy identifiers are migrated once from `deepgram_voice` and
  `plugin-deepgram-api_key`. A legacy Phone/Voice `deepgram` value is accepted
  only as migration input, written to the OS vault, then removed from renderer
  and future Supabase payloads.
- The existing Deepgram plugin's exact `deepgram/api_key` locator delegates to
  this same canonical vault, so plugin connect/test/remove cannot create a
  second app credential or lose access after migration.
- Browser preview uses the existing session-memory fallback and never persists
  the key.
- UI state contains only status, project metadata, timestamps, and safe error
  categories. A draft key exists only inside the password input until a
  validate-and-save operation finishes, then it is cleared.
- Validation uses `GET https://api.deepgram.com/v1/projects`, a read-only
  Management API request. Invalid credentials are not persisted.
- Saving, testing, replacing, or removing emits one non-secret status event so
  Providers, Speech-to-Text, Voice, and Phone/Voice update immediately.

## Provider usage

After validation, VibeSpace requests the official project usage breakdown when
the key has permission. The UI labels this as Deepgram-reported project usage.
Permission, network, or response failures are explicit and retain the last
successful timestamp. VibeSpace also records only numeric local STT duration
and calculated cost as a clearly labeled estimate. No request audio,
transcript, credential, or authorization header is persisted.

## Five STT choices

The catalog snapshot uses public pay-as-you-go streaming rates verified on
2026-08-02:

1. Nova-3 Monolingual (`nova-3`, `language=en`) — $0.0048/min.
2. Nova-2 Compatibility (`nova-2`, `language=en`) — $0.35/hour, normalized to
   $0.005833333/min; retained for language/filler-word compatibility.
3. Nova-3 Multilingual (`nova-3`, `language=multi`) — $0.0058/min.
4. Flux English (`flux-general-en`, `/v2/listen`) — $0.0065/min.
5. Flux Multilingual (`flux-general-multi`, `/v2/listen`) — $0.0078/min.

Nova-3 is explicitly marked the highest-performing general-purpose ASR because
that is Deepgram's current documented statement. It is not falsely ordered as
lower quality merely because it is cheaper. Flux is described as the
conversational/turn-detection choice, not as more accurate. Nova-2 is described
as compatibility, not as a recommendation.

The only numeric quality evidence shown is Deepgram's published Nova-3
streaming benchmark: 6.84% median word error rate across 2,703 files / 81.69
hours in nine domains. It is labeled as provider-published, English,
dataset-dependent evidence—not a promised user accuracy percentage. Flux and
Nova-2 use qualitative documented evidence. Free System and local models show
that no comparable app-wide accuracy estimate is available.

Sources:

- https://deepgram.com/pricing
- https://developers.deepgram.com/docs/models-languages-overview/
- https://developers.deepgram.com/docs/flux/flux-nova-3-comparison
- https://developers.deepgram.com/reference/manage/usage/breakdown/get
- https://deepgram.com/learn/introducing-nova-3-speech-to-text-api

## Runtime flow

Selecting Deepgram in Speech-to-Text exposes the shared credential control,
catalog, quality evidence, current snapshot date, calculator, and usage. The
selected catalog entry determines the streaming endpoint/model/language.
VibeSpace establishes the key and microphone before opening the socket, records
elapsed billable duration at close, and retains the existing smart formatting
and interim-result behavior for Nova. Flux uses its documented v2 endpoint and
turn-event protocol only where the existing dictation adapter can consume it
safely; otherwise the UI prevents selecting an unsupported runtime preset.

## Error and stale-data behavior

- Keyless: connect control, no provider request.
- Invalid/revoked: status becomes invalid; existing stored key can be replaced
  or removed.
- Network/permission: status explains that validation or live usage is
  unavailable without deleting a previously valid key.
- Pricing is a versioned documentation snapshot, visibly dated. If the snapshot
  becomes stale, calculator output is labeled stale rather than silently
  current.
- Removal deletes canonical and known legacy vault entries and broadcasts the
  disconnected state.

## Explicit exclusions

No production credential is created or used during tests. No Supabase schema,
Edge Function, billing, dependency, or generic LLM provider-ID change is
required. The phone cloud's server/operator Deepgram secret remains a separate
deployment credential; the app no longer treats a renderer/Supabase JSON value
as secure credential storage.
