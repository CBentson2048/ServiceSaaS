# App assets

`app.json` references `./assets/icon.png` for the iOS/Android app icon, the
Android adaptive-icon foreground, the splash image, and the web favicon.

## Required file

| File | Spec |
| --- | --- |
| `icon.png` | The Qlooqo app icon — **1024×1024 PNG**, square, no transparency. |

Save the provided icon artwork here as `icon.png`. The splash and adaptive-icon
background colour is `#A020F0` (set in `app.json`); if you want a separate,
padded Android foreground, add `adaptive-icon.png` and point
`android.adaptiveIcon.foregroundImage` at it instead.
