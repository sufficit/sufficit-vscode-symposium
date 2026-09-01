# Versioning Policy (CalVer)

The version follows the format: `YYYY.MMDD.X`

Where:
- `YYYY`: Current year (4 digits)
- `MMDD`: Current month and day (WITHOUT leading zeros - semver requirement)
  - Jan = 1, Feb = 2, ..., Dec = 12
  - Day = actual day number
  - Example: June 27 = "627" (NOT "0627")
  - Example: October 5 = "1005" (4 digits naturally)
- `X`: Auto-incrementing patch number starting from `.1`

## Examples:
- `2026.627.1` - First build on June 27, 2026
- `2026.627.2` - Second build on June 27, 2026 (after a fix or repackage)
- `2026.627.3` - Third build on June 27, 2026
- `2026.1005.1` - First build on October 5, 2026

## CRITICAL: Semver Requirement
The vsce tool (VS Code Extension Manager) and semver specification **FORBID** leading zeros in numeric identifiers. This means:
- ✅ `2026.627.1` (correct)
- ❌ `2026.0627.1` (REJECTED by vsce)

## How to update:
1. Keep the first two segments current: `YYYY.MMDD` (no leading zeros)
2. Only increment the last segment (`.1`, `.2`, `.3`, etc.)
3. Reset to `.1` when starting a new day

## Current Date: 2026-09-01
## Correct Version Format: 2026.901.X
