# 0007 — First Bot slice is talk-to-existing

The first ship is a roster of already-configured Hermes Bots and chat into them via multiplex (ADRs 0004–0006). Create, routines, `@mention`, and group chats are **not** in this slice.

After that runtime is proven, the next work is already decided — not a backlog guess:

1. New Agent from the phone (name, soul, inherit-or-empty provider keys, model pin)
2. Routines pane
3. `@mention`
4. Group chats

Avatars and full desktop-parity polish stay after those four. Non-Hermes CLI rows in the roster stay deferred (ADR 0004 option B).

Any commit, spec, or plan that starts this work opens by restating that order so "runtime succeeded" does not get mistaken for the whole Bot Mode port.
