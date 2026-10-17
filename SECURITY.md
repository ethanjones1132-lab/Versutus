# Security Policy

Versutus is a client for AI agent gateways (Hermes, a Versutus Gate, OpenClaw). It
holds no model credentials of its own, brokers nothing on anyone else's behalf, and
operates no public relay. Security reports are taken seriously.

## Supported versions

The **latest release** is the only supported version. Fixes land on the default
branch and ship in the next release; older tags and pre-release builds do not
receive security updates.

| Version | Supported |
|---|---|
| Latest release | Yes |
| Older releases | No |
| Pre-release / unreleased builds | No |

## Reporting a vulnerability

**Do not open a public issue, PR, or discussion for a suspected vulnerability.**

Report privately through **GitHub Security Advisories**: open the repository on
GitHub, go to the **Security** tab, and choose **Report a vulnerability**. That
starts a private advisory visible only to the maintainer, where the report can be
discussed and a fix coordinated before any public disclosure.

Please include, as far as you can:

- What the issue is and which component it affects — the app (`src/`), the
  Versutus Gate (`gate/`), or the portal seam.
- The app version, platform (Android / iOS / web), and — where relevant — the Gate
  and Hermes versions.
- Steps to reproduce, and any logs or proof-of-concept you can share safely.
- The impact you believe it has, and any suggested fix.

**Never paste secrets into a report.** Do not include gateway URLs that carry
credentials, pairing tokens, listen keys, provider keys, or `.env` contents. Redact
hostnames and IP addresses. If a token must be shown to demonstrate the issue,
replace it with an obvious placeholder.

## What to expect

- **Acknowledgement** of the report as soon as it is read.
- An assessment of severity and affected versions, and a decision on whether a fix
  is warranted.
- Credit in the advisory and release notes if you would like it; otherwise the
  report can stay anonymous.
- Please allow time for a fix to ship before disclosing the issue publicly. This is
  a single-author project, so timelines are best-effort, but reports are not
  ignored.

## Scope

In scope:

- The Versutus app — connection handling, credential and device-identity storage,
  the gateway/portal layer, and the deep-link entry points.
- The Versutus Gate (`gate/`) — providers, capabilities, pairing/access grants,
  and the service installer.

Out of scope:

- **Hermes Agent** and other upstream gateways. Report those to their own
  maintainers; Versutus consumes their APIs but does not ship them.
- The security of a gateway you operate. Versutus is a client: how a gateway is
  exposed (LAN, tailnet, public), authenticated, and configured is its operator's
  responsibility.
- Findings that require an already-compromised device, a malicious gateway that
  the user deliberately paired with, or physical access to an unlocked device.

If a report is better handled by an upstream project, it will be said plainly
rather than left unanswered.
