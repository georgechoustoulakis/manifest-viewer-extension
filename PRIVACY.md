# Privacy Policy — HLS Manifest Viewer

**Last updated: March 2026**

## Summary

HLS Manifest Viewer does not collect, store, or transmit any personal data to external servers.

## What the extension does

- Intercepts requests to `.m3u8`, `.m3u`, and `.mpd` URLs so they open in the viewer instead of downloading
- Fetches manifest content on your behalf to display it with syntax highlighting
- Stores recently viewed URLs locally in your browser using `chrome.storage.local`

## Data storage

All data (recent URLs) is stored locally on your device using Chrome's built-in storage API. It is never sent anywhere and is cleared when you uninstall the extension.

## Network requests

The extension makes network requests only to URLs you explicitly navigate to, in order to fetch and display the manifest content. Requests include your browser cookies for the relevant domain so that authenticated streams (e.g. behind a login) load correctly. No data is sent to any third-party server.

## Permissions

- **`storage`** — to save your recent URLs locally
- **`declarativeNetRequest`** — to redirect manifest URLs to the viewer
- **`host_permissions: <all_urls>`** — required because HLS manifests can be hosted on any domain

## Contact

For questions or concerns, open an issue at [github.com/georgechoustoulakis/manifest-viewer-extension](https://github.com/georgechoustoulakis/manifest-viewer-extension).
