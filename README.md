# Amanda Med Tracker

Amanda Med Tracker is a lightweight static medication-tracking PWA for post-surgery recovery and mobile-first dose logging.

## Canonical Local Workflow

This app is a static site. No framework install is required.

```powershell
cd C:\Users\Shaun\Desktop\amanda-med-tracker
python -m http.server 4173
```

Open `http://127.0.0.1:4173`.

## Smoke Check

```powershell
cd C:\Users\Shaun\Desktop\amanda-med-tracker
powershell -ExecutionPolicy Bypass -File .\smoke.ps1
```

The smoke script verifies:

- `index.html`, `manifest.json`, and `sw.js` are present
- the manifest is configured for standalone display
- the service worker caches the core static assets
- the page includes the primary medication logging affordances

## Verified Runtime Notes

Validated in a live local browser session on March 11, 2026:

- mobile layout renders correctly
- service worker/update banner is present
- medication logging modal opens and confirms correctly
- the update banner no longer blocks modal confirmation

## Deployment Posture

Current posture is `deployable preview` for any static host:

- local: `python -m http.server 4173`
- static hosting: Netlify, GitHub Pages, or any basic file server

## Product Scope

- primary use: quick dose logging on a phone
- persistence: local device/browser storage
- install mode: standalone PWA
- future scope: optional reminders, export/import, and recovery-plan customization
