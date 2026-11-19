# Retry HTML payload sanitization

Date: 2026-09-02
Release: 2026.902.3
Features: `symposium.recovery` 1.2.1, `symposium.chat-ui` 1.1.3

## Symptom

After an HTTP 503, clicking the manual Retry button rendered a very large
system notice containing the provider's complete HTML maintenance page. The
same raw payload was also included in the retry continuity prompt.

## Cause

Automatic recovery already normalized provider failures through
`conciseRetryReason`, but the manual retry path copied the raw error detail
directly from the webview into the status notice and outbound prompt.

## Resolution

The reason normalization is now a shared recovery boundary used by both
automatic and manual retry. It:

- preserves a concise HTTP status such as `HTTP 503 Service Unavailable`;
- replaces unclassified HTML documents with a generic provider-failure reason;
- removes markup content from non-document error fragments;
- bounds non-HTML provider text to 240 characters;
- keeps the full response available only in the original error's technical
  details, never in conversation or retry context.

## Verification

Focused tests cover manual retry, automatic retry, an HTTP status followed by
HTML and an HTML-only response. The package verification includes the complete
test suite, lint, formatting, type checks, architecture checks and VSIX
allowlist validation.
