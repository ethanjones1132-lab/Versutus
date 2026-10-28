# Changelog

All notable changes to Versutus are recorded here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are written for the person using the app. The commit history holds the rest.

## [Unreleased]

Nothing yet. Work merged after the release commit is collected here.

## [1.0.0]

This is the version in `package.json`. No v1.0.0 release tag or GitHub release exists yet, so these are
the candidate notes for the first public release.

### Added

- OpenCode agents can sit on the roster as Bots next to Hermes profiles, with the same
  Bot Chat. Only free models are offered, and a roster row is tagged with its runtime once
  more than one runtime answers (ADR 0016).
- Gate: an OpenCode 2.x server is detected and spoken to in its own dialect.

### Changed

- Chat rooms: a Bot's lamp colour keeps clear of the red, amber and mint status hues, so
  a room can no longer read as an error or a connection state.
- A Bot reply queued behind one that is still being spoken keeps its own voice options
  instead of borrowing the speaking reply's.
- Terminal: output full of control sequences is consumed without rescanning the plain
  lines before it, so a long Shell history stays responsive.
- A slow provider-catalogue read no longer shortens another request's own timeout.

### Fixed

- Home-screen widget: a push that carries only a work line or an approval count is kept
  instead of being merged away while another widget write is queued.
- Terminal JSON viewer: nested nodes with identical keys expand independently, and an
  empty string value is shown as an empty value rather than vanishing.
- Activity: a failed routine run says it failed instead of reading "completed"; the
  routine filter stops hiding rows once the list falls to three or fewer; single
  approve/deny is disabled while a batch decision is running.
- Voice: recovered speech is held until the merged composer draft is saved, so a failed
  save cannot lose it.
- Hands-free replies wait for punctuation before reading a decimal prefix aloud, instead
  of speaking the wrong number mid-sentence.
