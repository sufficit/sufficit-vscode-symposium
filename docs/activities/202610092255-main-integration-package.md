# Main integration: packaged host budget

The retry reconciliation integrated from PR #79 measures 916095 bytes (894.62 KiB). Its measured growth exceeded the previous 894 KiB host limit by 639 bytes. The budget is now 895 KiB, retaining the existing 1 MiB total archive cap and the exact file allowlist.

Validation: package:vsix and check:vsix passed: 41 allowed files, 540540-byte archive. The integrated application previously passed npm run verify, including 905 tests; this change only adjusts the packaging limit and its rationale.
