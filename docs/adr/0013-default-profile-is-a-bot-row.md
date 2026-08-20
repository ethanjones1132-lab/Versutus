# 0013 — Default profile is a Bot row

Supersedes ADR 0011.

Every Hermes profile is a Bot, including `default`. The roster is configurable chat first, then the full inventory — `default` among them. Two doors into the same `HERMES_HOME` are accepted: they are not the same row.

- **Configurable chat** — `bot` omitted, unprefixed listener. Model picker, sessions, CLI backend. The runtime door.
- **`default` Bot** — `bot=default` (or `/p/default/`). Lands on **Bot Chat** for that profile, with that profile's session switcher and New session. The Bot Mode door.

Tapping any Bot, including `default`, still targets that Hermes regardless of which backend configurable chat last used.

## Why reverse 0011

0011 treated the duplicate as a lie. The product call is that the Chat row and the default Bot row *do different jobs*, so listing both is correct. Skipping `default` hid the default agent from the Bot list Hermes Desktop shows.
