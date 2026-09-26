# Genius native queue bridge

## Objective and starting state

While a Genius turn was running, Symposium stored new messages only in its local Queued panel. The Genius host and Desktop had no pending item to display. Issue #69 tracks this change.

## Changes and decisions

- Busy submissions are sent to `genius exec` immediately with a stable client message ID and the same per-turn host instructions as ordinary dispatch.
- The local queue remains a UI projection. When the item reaches the front, Symposium attaches to the existing CLI child and replays any buffered events instead of submitting again.
- Removal, clear and Send next are forwarded through native queue commands. Native removal also clears the local row. The adapter waits for the `queued` acknowledgement before forwarding an immediate removal.
- Cancelling a turn sends `genius stop` to the resident host before ending the local CLI child. Version 2026.926.3 contains the bridge; the extension bundle allowance grows by 1 KiB to fit it.

## Validation and delivery

- Focused adapter, removal and cancellation tests passed.
- `npm run verify:package` passed: 851 tests, no failures; VSIX guardrails passed (41 files, 533,893 bytes).
- Companion Genius issue #1018 and CLI version 0.130.1. Installation and PR references are recorded in the delivery discussion.

## Limits

Native queueing starts once the Genius session UUID is known. A message queued before the first `session` record stays in Symposium until ordinary dispatch. Attachments remain subject to the existing Genius CLI limitation.
