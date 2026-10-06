// Loaded with `node --import` by the gate test scripts, in the runner process,
// so every test child inherits it.
//
// On macOS a CredentialVault built without an injected backend uses the login
// Keychain. A test that saves a secret through such a vault (chat-route's
// registry.secrets.set case does) would create a real Keychain item on the
// developer's Mac. Defaulting the test run to the 0600 file store keeps every
// test inside its temp Gate home; tests of the Keychain backend itself inject
// a fake /usr/bin/security. Windows keeps DPAPI and Linux already uses the
// file store, so only macOS is touched, and an explicit choice still wins.
if (process.platform === 'darwin' && !process.env.VERSUTUS_GATE_VAULT) {
  process.env.VERSUTUS_GATE_VAULT = 'file';
}
