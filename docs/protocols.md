# Three client protocols

All inference is performed by the real global OpenCode process. Client protocols
are translated to one internal history/tool representation, never directly to a
supplier HTTP call. The model list, aliases, access keys and configured defaults
are shared by all three routes.

| Protocol | Route | Authentication | Streaming |
| --- | --- | --- | --- |
| OpenAI Chat Completions | POST /v1/chat/completions | Authorization: Bearer KEY | chat.completion.chunk + [DONE] |
| OpenAI Responses | POST /v1/responses | Authorization: Bearer KEY | named response.* events with sequence_number |
| Anthropic Messages | POST /v1/messages | x-api-key: KEY or Bearer KEY | message_start / content_block_* / message_delta / message_stop |

GET /v1/models returns the same OpenAI-compatible model catalog for all clients.
For Anthropic SDKs set the base URL to the server origin (without `/v1`). OpenAI
SDKs use the origin plus `/v1`. The API key is the gateway access key configured
in this application's UI, not the supplier credential.

Supported: text history, system instructions, automatic client function tools,
parallel returned calls, matching tool results, streaming/nonstreaming output,
temperature/top_p, output limits, and model-supported reasoning effort.
Responses `max_output_tokens` maps to the core output limit. Anthropic requires
`max_tokens`; adaptive `output_config.effort` maps to OpenCode's native variants.
Configured model defaults apply only when the client omits the corresponding
parameter. Tool execution stays with the client; native OpenCode local tools,
skills and agent instructions are disabled for API requests.

Responses is stateless: `store=false` is always effective, including when omitted.
Send complete `input` history, including returned function_call items and matching
function_call_output items. No previous_response_id, retrieval, deletion,
background jobs, built-in search/computer tools, encrypted reasoning, automatic
truncation, images/files/audio, strict JSON output or forced function selection.
Unsupported semantics return HTTP 400 before inference. Only automatic tools or
disabled tools are accepted; serial tool batching cannot be guaranteed.

Responses reasoning summary events carry the textual reasoning that OpenCode
actually exposes; there is no provider-independent encrypted reasoning state.
Anthropic answer text and tool blocks are streamed normally. Provider reasoning
is **not** emitted as a thinking block because OpenCode cannot provide an
Anthropic-verifiable signature. Thinking tokens still count in actual usage.
Signed thinking history and fixed thinking budgets are explicitly unsupported.
`cache_control` blocks are accepted as client hints, but provider caching remains
controlled by OpenCode; the gateway does not promise Anthropic cache breakpoints.
Responses metadata is echoed in the response; Anthropic metadata is accepted but
not forwarded. Neither is sent as supplier inference options or retained in
request logs. Responses summary preferences do not control the provider's
reasoning text length.

Usage: OpenAI prompt totals include cached tokens. Anthropic separates ordinary
input, cache reads and cache creation. Output totals include reasoning. Actual
usage reported by OpenCode is still forwarded in responses.

The gateway does not collect persistent statistics or retain prompts, tool
arguments, or raw requests/responses as request logs. Existing statistics files
and request records are neither read nor deleted. Necessary process errors and
optional diagnostics may still be written to the terminal. The Windows desktop
app redirects the service's standard error output to `desktop.log` in the
configuration directory for troubleshooting. The management UI has no statistics,
request-log or effective-request views.

Stream-start envelopes and heartbeats do not count as first output. Partial
stream errors emit the protocol's error event and never a successful completion.
Downstream cancellation cancels the OpenCode request.

Reference event contracts:
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://platform.claude.com/docs/en/build-with-claude/streaming
