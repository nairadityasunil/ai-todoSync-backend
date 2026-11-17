# Pristine Shadow AI browser extension

Chrome and Edge (Manifest V3). It runs only on known AI sites.

- Shows whether the AI site is approved, allowed with conditions, prohibited or not reviewed yet (toolbar badge and popup).
- Blocks prohibited sites before they load, and shows the reason and the approved alternative. The block list comes from the server and refreshes hourly.
- Checks text **pasted** into an AI site for card numbers, national IDs, keys and passwords, emails and phone numbers. It stops risky pastes into tools that are not approved and warns for the rest. Only the kinds and counts go to the server; the text is checked in memory and dropped.
- Never gets in the way when the server cannot be reached: pastes go through.

Not covered: typed text (only paste is checked), file uploads, other browsers, mobile.

## Build and install

```
npm run build                                   # compiles the catalog the manifest is built from
SHADOW_AI_SERVER=https://your-api.example.com node extensions/shadow-ai/build.mjs
```

Roll the folder out with your device management, or load it unpacked in `chrome://extensions`. Each person opens the extension's settings and enters the server address and a token from Shadow AI → Sources (and optionally their work email, so use is tied to them). Without `SHADOW_AI_SERVER` the extension asks for permission to reach the address when it is saved.
