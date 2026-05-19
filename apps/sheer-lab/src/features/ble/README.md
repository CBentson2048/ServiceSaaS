# BLE Foundation

BLE scale integration is intentionally app-local because Sheer Lab is the native, hardware-sensitive staff app.

This module owns:
- Bluetooth permission checks/requests
- scan lifecycle and Acaia-like device filtering
- connect/disconnect/reconnect state
- Acaia service/characteristic discovery
- Acaia identify, notification request, and heartbeat commands
- notification subscription and weight packet decoding
- manual weight fallback state

Real-device test checklist:
- run `pnpm --filter @sheer/sheer-lab pods` after dependency installs
- confirm iOS Bluetooth permission prompt appears
- confirm Android Bluetooth scan/connect permissions appear
- scan near an Acaia Pearl and verify it is sorted as a likely Acaia device
- connect, verify service discovery succeeds, and confirm live grams update
- disconnect the scale and confirm reconnecting/error states preserve manual fallback
