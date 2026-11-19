# Fleet guidance for Sufficit Symposium

Resume from the saved mission plan, current PR head and prior test evidence.
Use the [maintainer testing guide](docs/maintainers/testing.md) to select
checks for the extension host, webview or backend affected by the change.

Identify the affected backend in CI and runtime reports. Keep findings from
one backend scoped to it unless comparison provides evidence for another.
Separate implementation checks from packaging and publication under the
[release procedure](docs/maintainers/release.md).

When a mission is blocked, record the exact check, environment or missing
access and the smallest next step before seeking a budget exception.
