# 0008 — Multiplex off fails honestly

If `gateway.multiplex_profiles` is off, the Gate does not write Hermes `config.yaml` and does not spawn a second listener. Named-Bot chat fails with a clear “enable multiplex” error and the host command. The default profile remains reachable on the unprefixed listener. The roster may still list Bots.

This slice does not become the first remote config write into Hermes home. `admin_config_rw` stays false. Attach-before-spawn (ADR 0003) stays intact.

## Considered

- **A (accepted):** Fail honestly; operator enables multiplex.
- **B:** Gate flips the flag. Rejected — first config mutation of Hermes home, same class refused for channel CRUD.
- **C:** Gate spawns a second Hermes for the named profile. Rejected — two writers on one home.

See ADR 0005 (routing) and ADR 0007 (slice 1 is talk, not create).
