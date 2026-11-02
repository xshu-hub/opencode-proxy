# OpenCode Proxy

Develop the Magpie provider plugin only. Magpie owns the client-facing gateway, authentication, routing, model controls and protocol conversion. Do not restore a standalone gateway, desktop app or management UI. Expose Chat Completions to Magpie and keep only the necessary OpenCode bridge. All inference must use the real global OpenCode program; do not modify OpenCode or bypass it to call suppliers. Preserve global authentication/provider configuration, unlimited concurrency by default, and short model names.

Run npm test and checks relevant to the changed path. The optional compatibility workflow uses disposable profiles and local mock upstreams; never use production credentials for CI. Keep secrets/config.json/logs outside Git. Use CodeGraph first if a .codegraph directory exists; otherwise skip it.
