# Three client protocols

All inference is performed by the real global OpenCode process. Client protocols
are translated to one internal history/tool representation, never directly to a
supplier HTTP call. The model list, aliases, access keys and configured defaults
are shared by all three routes.
Optional [upstream channels](channels.md) add per-channel Key rotation and sticky
sessions while retaining existing global authentication. All three routes accept
`x-opencode-session-id` or `metadata.session_id`; the session identifier is used
only for routing and is not sent as model input.
These are compatibility subsets, not full implementations of
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

Supported: text history, system instructions, automatic/required/named client function tools,
parallel returned calls, matching tool results, streaming/nonstreaming output,
temperature/top_p, output limits, and model-supported reasoning effort.
Responses `max_output_tokens` maps to the core output limit. Anthropic requires
`max_tokens`; adaptive `output_config.effort` maps to OpenCode's native variants.
Anthropic `top_k` maps to the public OpenCode `topK` parameter hook.
Configured model defaults apply only when the client omits the corresponding
parameter. Tool execution stays with the client; native OpenCode local tools,
skills and agent instructions are disabled for API requests.

Responses defaults to `store=false`, including when omitted. Explicit `store=true`
enables a bounded, process-local conversation cache: 30 minute TTL, at most 256
responses / 32 MiB total, 4 MiB per response, oldest entries evicted first. State
is isolated by the authenticated gateway key ID and disappears on process exit.
It is never persisted or included in diagnostic logs. GET and DELETE
`/v1/responses/{id}` retrieve/delete owned snapshots; missing, expired, evicted,
deleted and other clients' IDs return 404. `previous_response_id` restores the
stored input/output history; generation options and `instructions` are supplied
for the new request and are not inherited. Deleting a parent does not delete an
already-created child snapshot. Only completed/incomplete terminal responses are
cached; failed and cancelled streams create no stored response.
With `store=false`, send complete `input` history, including function_call and matching
function_call_output items. Returned `output` items can be appended unchanged to
the next request: output-text annotations/logprobs are accepted as metadata, and
text reasoning summaries stay attached to the corresponding assistant turn.
`include:["reasoning.encrypted_content"]` is accepted as an optional include hint;
no encrypted state is generated. Input reasoning may omit `encrypted_content`
or set it to null; non-null opaque state cannot be restored and returns HTTP 400.
Background jobs, built-in search/computer tools, encrypted reasoning, automatic
truncation and remote/file-ID attachment retrieval remain unavailable.
Unsupported semantics return HTTP 400 before inference.

Responses client tools additionally accept `namespace` groups (the `tools`
array contains function/custom leaves) and freeform `custom` tools with omitted
format or `format:{type:"text"}`. Namespace/name/type identities have reversible,
collision-checked internal aliases; the original identity is returned in JSON,
SSE and stored/stateless history, including when historical tools are no longer
declared. Function choices may carry `namespace`; custom choices use
`{type:"custom",name:...}`. Named and required choices retain their constraints.
Custom input is carried through a strict internal `{input:string}` function and
restored as `custom_tool_call.input`, without escaping or parsing its text.
Streaming uses `response.custom_tool_call_input.delta` / `.done`; the raw input
is emitted after the native JSON wrapper is complete and validated. Custom
results use `custom_tool_call_output`. Tool declarations remain client-owned;
neither functions nor custom code run in the proxy. Custom grammar formats,
hosted tools/tool search, and `defer_loading:true` are rejected explicitly:
OpenCode has no equivalent constrained text decoder or deferred-tool lifecycle.
The mapping does not silently discard these guarantees.

Chat `response_format` supports text, json_object and json_schema; Responses
`text.format` supports the same, and Anthropic supports
`output_config.format:{type:"json_schema",schema:...}`. Schemas are locally
compiled/validated with draft-07 keywords and standard string formats (at most
64 KiB per compiled schema; unknown schema keywords/formats and unresolved remote
references fail explicitly). Strict function argument schemas
are also validated before returning calls. Invalid constrained output returns an
explicit 502, rather than an apparently successful response violating the schema.

Required/named function selection and `parallel_tool_calls:false` (Anthropic
`disable_parallel_tool_use:true`) use a constrained calls array; a serial request
returns at most one call and a required request returns at least one. Client
functions still execute only in the client. With explicitly disabled thinking,
constraints use OpenCode's public structured-output format. Otherwise a scoped
MCP JSON-capture tool avoids the native format's forced `tool_choice=required`,
which some thinking providers reject. Thinking controls are preserved. The
capture tool only returns data, never runs client functions or local actions.
Chat accepts `parallel_tool_calls:true`, `response_format:{"type":"text"}` and
`store:false`. Chat `user`/`metadata` are accepted as hints without forwarding or
logging. Empty Chat `stop` and Anthropic `stop_sequences` lists are accepted;
nonempty custom stop sequences cannot be mapped through the public hooks.

Anthropic custom tools accept `type:"custom"`, boolean `strict` and the optional
`eager_input_streaming` flag. Streaming still returns standard `tool_use` and
`input_json_delta` events with the complete argument JSON once OpenCode exposes
it. Native pending-tool events expose the original client tool ID/name before
the complete arguments arrive. Chat sends the identity once, then argument
deltas with the same index; Responses and Messages use their corresponding
item/block lifecycle. No completed call is emitted for unfinished arguments.
Eager streaming is a latency preference; the proxy cannot promise partial
arguments before then. Server-native tools remain unsupported.

Inline attachments are translated to OpenCode file parts, preserving order with
text. Chat accepts image_url, file.file_data and input_audio; Responses accepts
input_image/input_file; Anthropic accepts base64 image/document or text document
blocks. Supported MIME types are PNG/JPEG/GIF/WebP, PDF, UTF-8 text, WAV and MP3.
Use base64 data URLs; remote URLs, local file paths and server file IDs are
rejected. Text documents are decoded as text. Other modalities require the
selected model to advertise the matching OpenCode input capability, otherwise a
clear HTTP 400 is returned before inference. This does not give text-only models
vision/audio capability. Responses function/custom tool outputs may contain
`input_text`, `input_image` and `input_file` parts; Anthropic tool results may
contain text, base64 image and document blocks. Text remains the native tool
output. Media is lifted to an attributed user continuation after all results in
the parallel call batch, preserving each originating call ID and reversed result
ordering. The same inline-only validation and model capability gates apply; no
image is silently dropped. Anthropic `is_error:true` is represented by a
`Tool error: ` prefix, since native OpenCode history has no portable error flag.

Responses reasoning summary events carry the textual reasoning that OpenCode
actually exposes; there is no provider-independent encrypted reasoning state.
Anthropic exposes that same native reasoning as `thinking` blocks and streaming
`thinking_delta` events, with an empty `signature` to identify unsigned
compatibility output. No Anthropic-verifiable signature or encrypted state is
invented. DSH's DeepSeek Messages adapter can display and replay these blocks;
unsigned history (an omitted or empty signature) maps back to OpenCode reasoning
parts. Nonempty provider signatures and redacted thinking remain unsupported.
`thinking.display:"omitted"` hides reasoning while preserving generation and
usage; the default and `display:"summarized"` expose the text OpenCode provides,
without generating an extra summary. Adaptive thinking enables native thinking
using the selected effort or native enabled variant. Anthropic and Chat clients can send
`thinking:{"type":"enabled"}` without a budget as a mode toggle. The proxy keeps
an already-enabled native default or selects an available positive OpenCode
variant (preferring high, then medium/low). A known OpenAI SDK can use its native
high effort when the model advertises reasoning without named variants. Explicit
client effort wins; a conflicting disabled model default does not override the
toggle. `thinking:{"type":"disabled"}` uses native disabled thinking or none
effort, and does not require an Anthropic model to define a none variant.

`thinking:{"type":"enabled","budget_tokens":N}` is a separate request: the
numeric budget is preserved through the native Anthropic SDK as `budgetTokens`.
It must be an integer of at least 1024 and below the request's output limit.
SDKs that only expose effort levels reject numeric budgets explicitly instead of
guessing an effort or discarding the budget. Unsupported thinking modes fail
before supplier inference; omitted thinking controls preserve existing defaults.
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
Once a genuine successful SSE response is available, the HTTP listener flushes
its headers and forwards chunks with backpressure. Idle established streams
receive SSE comment heartbeats every 15 seconds. `no-transform` and
`X-Accel-Buffering: no` discourage intermediary buffering; these cannot force
arbitrary client/proxy rendering behavior. The listener does not send a
speculative HTTP 200 while model preparation or the first usable output is
pending: startup, capability and rate-limit errors retain their HTTP status.
Successful protocol completion and EOF do not wait for resource recycling.
Session abort confirmation, session deletion, global instance reset and transient
file removal finish in the background, and only then can that exclusive process
be acquired again. Failed resets discard the process. Shutdown drains tracked
recycling; unsuccessful/interrupted requests still await safe cancellation.
If a provider leaks a DeepSeek DSML call batch as ordinary assistant text, the
proxy can recover a complete batch at the start of the answer or on its own line
after introductory prose into standard
client tool calls (including Anthropic `tool_use` and `stop_reason: tool_use`).
Introductory prose continues streaming immediately and is preserved once in the
assistant history; it is not buffered until the batch completes. Only native tool
names or unambiguous original client names declared on the current request are
eligible. Original names map back to the same registered native tool; arguments
must match their JSON Schema, and the full batch is validated before emission.
String parameters are preserved literally, without XML entity decoding or code
execution. Recovery buffers at most 1 MiB and 128 calls. Incomplete, unknown,
invalid or interrupted batches fail explicitly instead of ending successfully
with raw markup. Inline markup, Markdown fences/code spans, indented code,
quotes and explicitly labelled examples remain text. Recognition is deliberately
conservative: a standalone batch outside those contexts is required, with up to
three leading spaces; ambiguous example/syntax descriptions are not promoted to
calls. Per-line context is bounded to 4096 characters; after an overlong line,
further markup stays literal for that response instead of guessing its quoting
context. With no eligible tools or `tool_choice: none`, recovery is disabled. The
proxy still executes no client functions and adds no supplier inference/retry.
OpenCode owns transport retries. Before the first text/reasoning/tool output, the
proxy permits up to two native retries, bounded by existing timeout settings;
the third retry notification or an excessive retry delay returns 429/503 and a
Retry-After hint. Original public API error status and Retry-After are preserved.
After output starts, retries are stopped with a protocol error to avoid replaying
partial text or duplicate client actions. Broken/failed workers are retired;
subsequent requests can create fresh workers. No independent supplier retry or
direct supplier HTTP call is added by the proxy.
Cold OpenCode worker initialization is paced to two starts at a time to avoid
Windows process/thread initialization failures during bursts. Requests wait in
the cancellable startup phase under the existing startup timeout. This does not
limit admitted requests or concurrently running inference; `maxConcurrent=0`
still means unlimited. An explicitly configured maxConcurrent continues to
reject excess requests with 429 instead of growing the startup queue.

The managed gateway asynchronously prewarms enabled global OpenCode models
without calling `prompt_async` or performing supplier inference. `warmupModels`
selects initial targets; an empty list chooses enabled catalog models, capped by
`maxIdleWorkers` (default 2), with equivalent aliases deduplicated. Recent real
requests update the hot targets so an unused startup selection cannot prevent
other models from being retained. Busy/resetting workers count toward target
coverage rather than causing a new standby to launch on every short request.
Selected idle targets stay hot until stopped; other idle leases expire after
`workerIdleMs` (default 60 seconds). Stopping the gateway clears hot retention;
closing the runtime disposes all workers. Setting `workerReuse:false` or
`maxIdleWorkers:0` disables prewarming. Each pending warm/reset lease admits one
cancellable waiter; additional concurrent misses create exclusive workers under
the existing startup gate, rather than serializing inference behind a hot lease.
Configuration changes and catalog refreshes replace the generation and schedule
fresh readiness; no worker crosses a model, configuration or credential key.

Protocol references:
- https://developers.openai.com/api/reference/resources/responses/streaming-events
- https://developers.openai.com/api/docs/guides/migrate-to-responses
- https://platform.claude.com/docs/en/build-with-claude/streaming
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming
- https://platform.claude.com/docs/en/api/models/list
- https://api-docs.deepseek.com/guides/anthropic_api/
