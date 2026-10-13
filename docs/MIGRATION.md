# Migration

The standalone core was extracted from bridge 0.13.0, commit 210234a5f33e0f2643f82b4337e249cf0fe81371. The old Magpie fork is historical; further development is here.

Existing global-mode config.json can be copied here. Explicit timeoutMs:120000 still caps total duration; remove it or set 0 to disable that cap. Upstream credentials remain managed by OpenCode. The client API key belongs to this HTTP service, not the upstream.

The Magpie provider adapter and its host tests were removed. Worker environment/temp prefixes were renamed; no OpenCode source or binary changes were made.
