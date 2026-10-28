# Migration

The standalone core was extracted from bridge 0.13.0, commit 210234a5f33e0f2643f82b4337e249cf0fe81371. The old Magpie fork is historical; further development is here.

Existing global-mode config.json can be copied here. Explicit timeoutMs:120000 still caps total duration; remove it or set 0 to disable that cap. Upstream credentials remain managed by OpenCode. The client API key belongs to this HTTP service, not the upstream.

The Magpie provider adapter and its host tests were removed. Worker environment/temp prefixes were renamed; no OpenCode source or binary changes were made.

Since 0.8.0, the management UI is independently implemented with native ES modules and CSS. Magpie frontend code and assets are no longer shipped. Magpie references in the provenance and copyright notices describe the bridge core's origin; they are not runtime or build dependencies.

Persistent statistics and request recording have been removed. The management UI no longer provides statistics, request-log or effective-request views, and the old `/admin/request/` endpoints are unavailable. Existing `statistics.json` files and request records are neither read nor deleted; they do not need to be copied for the service to run. Prompts, tool arguments and raw requests/responses are not retained as request logs. Actual OpenCode usage is still forwarded in API responses.

Necessary process errors and optional diagnostics remain available on the terminal. The Windows desktop app redirects the service's standard error output to `desktop.log` in the configuration directory for troubleshooting. This process log is separate from the removed request-recording feature.

Upstream channels, provider-Key rotation and sticky Key bindings have been removed. Configure providers and authentication in local global OpenCode. On reading older settings, an empty `channels` field is removed; nonempty legacy settings are first backed up verbatim beside the configuration file as `<file>.before-local-only.<random-id>.json`. Neither the retired field nor its credentials appear in management state. Gateway access keys and client-isolated Responses memory history remain supported.

OpenCode 1 users can opt into `workerSharing: true` in Network settings to share a process across independent request instances. It defaults to false. Isolation, working-directory semantics, fault boundaries and the local memory comparison are documented in [shared processes](shared-processes.md).
