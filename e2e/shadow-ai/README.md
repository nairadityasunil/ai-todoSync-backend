# Shadow AI end-to-end checks

These run against a live backend and database, not mocks. Run them from the repository root.

- `api.mjs`: the REST API (tools, decisions, requests, tokens, code scan, hourly check, compliance, agent blocking).
- `connectors.mjs`: Google Workspace and Microsoft Entra connectors and the gateway hooks, against `idp-stub.mjs`, a small server shaped like the Google Admin SDK and Microsoft Graph.
- `ui.mjs`: the portal in a real browser (needs the portal running and `playwright` installed).

Start the backend with these set so the connectors call the stub instead of the real services:

```
SHADOW_AI_GOOGLE_TOKEN_URL=http://127.0.0.1:4555/g/token
SHADOW_AI_GOOGLE_DIRECTORY_URL=http://127.0.0.1:4555/g/dir
SHADOW_AI_MICROSOFT_LOGIN_URL=http://127.0.0.1:4555/m
SHADOW_AI_MICROSOFT_GRAPH_URL=http://127.0.0.1:4555/m/graph
```

Then `node e2e/shadow-ai/api.mjs`, `connectors.mjs` and `ui.mjs`. They expect a user `qa@example.com` (password `Password123!`) who owns a workspace. They clear the shadow AI collections first, so use a test database.

The stub proves the code follows the documented API shapes. It does not prove a real tenant is configured correctly.
