# Public release preparation

This public repository uses a fresh source snapshot. Private Git history, PRs, discussions, logs and artifacts were not imported. No downloadable release or marketplace submission is approved by this snapshot.

## Bounded privacy review

The final source files were checked for credential patterns, private conversation links, personal paths and contact information. Key-like strings in tests are explicit fixtures. No apparent live credentials were identified; this is not a guarantee that every possible secret is detectable.

Logo and tray PNG artwork was visually inspected and its metadata checked. The demo GIF was visually reviewed. Its staged GitHub visibility screen and fake profile are intentional mockups, confirmed by the owner; the GIF is retained. Copyright attribution and dependency license metadata are retained. A maintainer email was removed from a dependency deprecation warning in the lockfile; versions and integrity hashes are unchanged.

## Before downloadable release

- Test the real OpenAI tunnel end to end; automated reconnect tests use a stand-in tunnel.
- Check tray behavior, start at login, and sleep/wake on real Windows and Mac machines.
- Desktop builds are unsigned. Decide signing and notarization before presenting them as trusted installers.
- Explain that screenshots and page text go to the assistant and recordings remain local.
- Local Claude works without a tunnel. ChatGPT desktop connections require a tunnel and the relevant OpenAI permissions.
- Inspect newly built installers and package contents before publication. Marketplace submission is a separate task.

## CI controls

Workflows retain relevant-file path filters, read-only contents permissions, manual dispatch, native test matrices, and cancellation of superseded runs. Configure branch protection deliberately: path-filtered workflows do not create checks for unrelated edits.
