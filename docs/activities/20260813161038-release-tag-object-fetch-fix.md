# Release tag object fetch fix

Status: **Completed**
Date: 2026-08-13

## Activity

Diagnosed the failed `v2026.813.3` publication check and made the annotated
tag guardrail reliable in the GitHub Actions checkout.

## Diagnosis

The local tag was correctly annotated, but the checkout used by the publish
workflow exposed only the peeled commit under `refs/tags/*`. The guardrail
therefore could not observe the remote tag object and rejected a valid release.

## Delivered

- the publish workflow explicitly fetches the exact tag ref before validating;
- the original `v2026.813.3` tag remains immutable;
- the next release carries the corrected workflow and guardrail.
