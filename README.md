# X Block & Mute Search Filter

Chrome extension that hides blocked and muted accounts from X (Twitter) search results.

Japanese README: [README.ja.md](README.ja.md)

## Features
- Hides posts from blocked and muted accounts on X search pages.
- Imports your muted/blocked lists from X using your logged-in session.
- Updates lists immediately after mute/block actions on X.
- Shows list counts and hidden account counts in the extension popup.

## Requirements
- Logged-in X account in your browser.

## Install (local)
1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this folder

## Usage
1. Open X search (`https://x.com/search?...`).
2. Click the extension icon to open the popup.
3. Click "Fetch muted/blocked lists".
4. The popup shows "Import complete" when finished.

## Refresh after adding a block/mute
Mute/block changes are reflected automatically when you perform them on X.
If the list looks out of sync:
1. Click the extension icon.
2. Click "Fetch muted/blocked lists".
3. Wait for the "Import complete" message in the popup.

## Notes
- The extension only runs on X search pages.
- Data is stored locally in `chrome.storage.local`.
- If import fails, open `https://x.com/settings/muted/all` and
  `https://x.com/settings/blocked/all` once to re-capture API parameters.

## License
MIT. See [LICENSE](LICENSE).
