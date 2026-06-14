# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest release on [GitHub Releases](https://github.com/Cookie774-GameDev/VibeSpace/releases) | Yes |
| Older releases | Best effort |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security bugs.**

Email **security@vibespaceos.com** (or open a private [GitHub Security Advisory](https://github.com/Cookie774-GameDev/VibeSpace/security/advisories/new) if enabled) with:

- Description of the issue and impact
- Steps to reproduce
- Affected version(s)
- Proof of concept if available

We aim to acknowledge reports within **72 hours** and will coordinate disclosure timing with you.

## What belongs in reports

- Authentication or authorization bypass
- Exposure of user data across tenants
- Remote code execution in the desktop app or edge functions
- Webhook signature verification failures (Stripe, Twilio)
- Leaked secrets in release binaries

## Out of scope

- Unsigned Windows/macOS installers (known until code signing ships)
- Issues requiring physical access to an unlocked machine
- Social engineering

## Safe harbor

We welcome good-faith research. Do not access other users' data, disrupt production services, or publicly disclose before we have had a chance to fix the issue.
