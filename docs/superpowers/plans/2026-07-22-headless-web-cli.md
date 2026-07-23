# Headless Web CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Run Chat2API on a Linux server without Electron UI while providing a secured Web management UI for provider accounts and browser-based login.

**Architecture:** Extract shared proxy, store, provider, session, and management services from Electron lifecycle code. Add a headless CLI entry that starts HTTP proxy plus Web Admin/API, while Electron remains a desktop shell using the same services. Reuse the existing React renderer through an HTTP API client.

**Tech Stack:** TypeScript, Node.js, Koa, React, existing Electron IPC services, existing provider OAuth/token adapters, `npm run start:headless`.

---

### Task 1: Define shared runtime boundaries

**Files:**
- Create: `src/main/runtime/createApplicationRuntime.ts`
- Modify: `src/main/index.ts`
- Test: `tests/runtime/application-runtime.test.ts`

- [ ] Move proxy/store/provider/session initialization into a runtime factory that has no `BrowserWindow`, tray, updater, or IPC dependency.
- [ ] Return explicit `start`, `ready`, and `shutdown` operations plus proxy and management service handles.
- [ ] Keep Electron setup responsible only for window/tray/IPC wiring and call the shared runtime factory.
- [ ] Test startup and shutdown without importing or constructing Electron UI objects.

### Task 2: Add headless CLI entry and configuration loading

**Files:**
- Create: `src/cli/index.ts`
- Create: `src/cli/config.ts`
- Modify: `package.json`
- Test: `tests/cli/headless-cli.test.ts`

- [ ] Add `npm run start:headless` to run the compiled CLI entry.
- [ ] Load JSON configuration from `CHAT2API_CONFIG`, with XDG-compatible defaults for config/data directories.
- [ ] Apply `CHAT2API_HOST`, `CHAT2API_PORT`, `CHAT2API_DATA_DIR`, `CHAT2API_LOG_LEVEL`, and admin-auth settings as environment overrides.
- [ ] Default server binding to `0.0.0.0` only when explicitly configured for server mode; fail closed if public binding has no admin authentication.
- [ ] Print proxy URL, Web Admin URL, config/data source, readiness, and one-time bootstrap URL without printing credentials or secrets.
- [ ] Handle SIGINT/SIGTERM with bounded graceful shutdown and non-zero exit on startup failure.

### Task 3: Expose provider-neutral Web management APIs

**Files:**
- Create: `src/main/management/managementRouter.ts`
- Create: `src/main/management/authService.ts`
- Modify: existing IPC handler/service modules under `src/main/ipc/` and provider/account services
- Test: `tests/management/management-auth.test.ts`, `tests/management/management-router.test.ts`

- [ ] Reuse existing service methods behind HTTP routes for provider, account, session, config, logs, and login operations; do not duplicate business logic in route handlers.
- [ ] Implement first-start bootstrap token, one-time consumption, administrator password setup, password verification, session-cookie issuance, logout, expiration, and session invalidation.
- [ ] Bind OAuth `state` and callback handling to the authenticated login session with timeout, cancellation, replay protection, and provider ID validation.
- [ ] Keep `/health` public, protect management routes, and define separate authentication for `/v1/*` proxy requests.
- [ ] Add tests for bootstrap replay, wrong password, expired session, CSRF/state mismatch, unauthenticated access, and public health access.

### Task 4: Serve the existing React UI over HTTP

**Files:**
- Create: `src/main/management/staticWebServer.ts`
- Modify: `src/renderer/src/` API client boundary and auth bootstrap flow
- Test: `tests/management/web-admin-serving.test.ts`

- [ ] Serve the built renderer assets and history-fallback routes from the headless server.
- [ ] Introduce a renderer API client interface with Electron IPC and HTTP implementations; migrate pages from direct `window.electronAPI` calls to the interface without changing provider/account behavior.
- [ ] Add bootstrap/login/logout handling using HttpOnly cookies and display the provider login URL/status in the existing UI.
- [ ] Ensure Electron uses the IPC implementation and headless mode uses HTTP without bundling Electron-only APIs into the browser path.
- [ ] Test static asset serving, SPA fallback, API base URL resolution, auth bootstrap, and renderer startup without `window.electronAPI`.

### Task 5: Implement provider login adapters for the first support set

**Files:**
- Modify: existing provider OAuth/token adapters under `src/main/oauth/` and provider modules
- Test: provider-specific login tests under `tests/providers/`

- [ ] Extract non-UI OAuth/token exchange logic into shared services.
- [ ] Support the existing standard OAuth/token paths first for GLM, Qwen, Kimi, and DeepSeek.
- [ ] Return a typed login status and credential-save result to the Web UI.
- [ ] Leave browser-cookie/automation-only providers explicitly unsupported in the first version and report that state in the UI.
- [ ] Verify credentials are stored through the existing store path and never placed in URLs or ordinary logs.

### Task 6: Linux/server acceptance and operational packaging

**Files:**
- Modify: `package.json`
- Create: `docs/deployment/headless-linux.md`
- Create: `deploy/chat2api.service`
- Test: `tests/cli/`, `tests/management/`, build artifact checks

- [ ] Build the Linux target and verify the CLI artifact does not require `DISPLAY`, `BrowserWindow`, tray, or renderer startup.
- [ ] Start the CLI in a no-desktop Linux environment, verify `/health`, `/ready`, Web Admin bootstrap, provider login callback, and an OpenAI-compatible request.
- [ ] Verify SIGTERM closes the listener, flushes config/session state, and cleans child/provider sessions.
- [ ] Add a systemd example with environment file and XDG data paths; document reverse-proxy HTTPS deployment for public access.
- [ ] Run focused tests, build, Linux CLI smoke test, and one authenticated end-to-end management flow before declaring the server mode complete.

---

## Assumptions

- The first server mode reuses the existing React UI and does not create a separate admin frontend.
- The server prints a URL for the user’s browser; it does not require launching a visible Chrome process on the server.
- Standard OAuth/token login paths are first; provider-specific cookie automation is later.
- Public binding requires management authentication; secrets are supplied via config file or environment, never CLI arguments.
