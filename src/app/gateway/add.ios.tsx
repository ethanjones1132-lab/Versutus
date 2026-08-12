// Shared add flow (identify + access handshake + deep-link params + TLS card).
// Keep the iOS route as a re-export so SwiftUI experiments cannot drift from
// the Android/web path again.
export { default } from './add';
