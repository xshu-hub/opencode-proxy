# Three client protocols

All inference is performed by the real global OpenCode process. Client protocols
are translated to one internal history/tool representation, never directly to a
supplier HTTP call. The model list, aliases, access keys and configured defaults
are shared by all three routes.
These are text/function-tool compatibility subsets, not full implementations of
every OpenAI or Anthropic feature.

| Protocol | Route | Authentication | Streaming |
| --- | --- | --- | --- |
| OpenAI Chat Completions | POST /v1/chat/completions | Authorization: Bearer KEY | chat.completion.chunk + [DONE] |
| OpenAI Responses | POST /v1/responses | Authorization: Bearer KEY | named response.* events with sequence_number |
| Anthropic Messages | POST /v1/messages | x-api-key: KEY or Bearer KEY | message_start / content_block_* / message_delta / message_stop |

GET /v1/models and GET /v1/models/{id} expose the same enabled short aliases.
Bearer requests use OpenAI model objects. Requests carrying `anthropic-version`
or `x-api-key` use Anthropic model objects (`type`, `display_name`, `created_at`),
with `has_more`, `first_id`, `last_id` on lists. Anthropic lists support `limit`
(1-1000, default 20) and one of `before_id`/`after_id`; IDs sort alphabetically.
Configured context/output limits are exposed; unknown provider capabilities are
null and the unknown model release date uses the epoch value.
Disabled models and their original IDs do not appear in this catalog.
For Anthropic SDKs set the base URL to the server origin (without `/v1`). OpenAI
SDKs use the origin plus `/v1`. The API key is the gateway access key configured
in this application's UI, not the supplier credential.
`x-api-key` is also accepted for model discovery. Bearer takes precedence when
both authentication headers are present. `/v1/messages/count_tokens` returns an
Anthropic HTTP 501 error: OpenCode has no token-count-only public endpoint, and
the proxy neither starts inference nor fabricates a token estimate for it.

The API listener supports browser CORS preflight and explicit access-key headers;
it does not use browser cookies. The separate management listener retains its
local-only authentication and origin checks.

Supported: text history, system instructions, automatic client function tools,
parallel returned calls, matching tool results, streaming/nonstreaming output,
temperature/top_p, output limits, and model-supported reasoning effort.
Responses `max_output_tokens` maps to the core output limit. Anthropic requires
`max_tokens`; adaptive `output_config.effort` maps to OpenCode's native variants.
Anthropic `top_k` maps to the public OpenCode `topK` parameter hook.
Configured model defaults apply only when the client omits the corresponding
parameter. Tool execution stays with the client; native OpenCode local tools,
skills and agent instructions are disabled for API requests.

Responses is stateless: `store=false` is always effective, including when omitted.
Send complete `input` history, including returned function_call items and matching
function_call_output items. Returned `output` items can be appended unchanged to
the next request: output-text annotations/logprobs are accepted as metadata, and
text reasoning summaries stay attached to the corresponding assistant turn.
`include:["reasoning.encrypted_content"]` is accepted as an optional include hint;
no encrypted state is generated. Input reasoning may omit `encrypted_content`
or set it to null; non-null opaque state cannot be restored and returns HTTP 400.
No previous_response_id, response retrieval/deletion,
background jobs, built-in search/computer tools, encrypted reasoning, automatic
truncation, images/files/audio, strict JSON output or forced function selection.
Unsupported semantics return HTTP 400 before inference. Only automatic tools or
disabled tools are accepted; serial tool batching cannot be guaranteed.
Chat accepts `parallel_tool_calls:true`, `response_format:{"type":"text"}` and
`store:false`. Chat `user`/`metadata` are accepted as hints without forwarding or
logging. Empty Chat `stop` and Anthropic `stop_sequences` lists are accepted;
nonempty custom stop sequences cannot be mapped through the public hooks.

Anthropic custom tools accept `type:"custom"`, `strict:false` and the optional
`eager_input_streaming` flag. Streaming still returns standard `tool_use` and
`input_json_delta` events with the complete argument JSON once OpenCode exposes
it. Eager streaming is a latency preference; the proxy cannot promise partial
arguments before then. Strict schemas and server-native tools remain unsupported.

Responses reasoning summary events carry the textual reasoning that OpenCode
actually exposes; there is no provider-independent encrypted reasoning state.
Anthropic answer text and tool blocks are streamed normally. Provider reasoning
is **not** emitted as a thinking block because OpenCode cannot provide an
Anthropic-verifiable signature. Thinking tokens still count in actual usage.
Signed thinking history and fixed thinking budgets are explicitly unsupported.
Adaptive thinking accepts `display:"omitted"`; signed thinking output is never
invented for other display modes.
`cache_control` blocks are accepted as client hints, but provider caching remains
controlled by OpenCode; the gateway does not promise Anthropic cache breakpoints.
Responses metadata is echoed in the response; Anthropic metadata is accepted but
not forwarded. Neither is sent as supplier inference options or retained in
request logs. Responses summary preferences do not control the provider's
reasoning text length.

The top-level `dsh_plugin_packages` extension is accepted and discarded on all
three routes. DeepSeek Harness uses it for active plugin package names and
versions, separate from model input (see its [wire extension reference](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/deepseek-llm-api-wire-extensions.md#dsh_plugin_packages)).
The proxy does not load these packages, forward the inventory to OpenCode, or
store or echo it. Other unknown fields remain unsupported.

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

Protocol references:
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
- https://platform.claude.com/docs/en/api/models/list
