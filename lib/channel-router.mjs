import { ApiError, validateRequest } from './protocol.mjs';

export class ChannelRouter {
  constructor(config, Bridge, pool) {
    this.config = config;
    this.Bridge = Bridge;
    this.pool = pool;
    this.bridges = new Map();
    this.channels = config.channels ?? [];
    this.models = Object.fromEntries(
      this.channels.flatMap((channel) =>
        channel.models.map((model) => [
          model.alias,
          {
            ...model,
            model: 'channel:' + channel.id + '/' + model.alias,
            channelId: channel.id,
            protocol: channel.protocol,
            baseURL: channel.baseURL,
            enabled: channel.enabled,
            reasoningAdapter: 'native',
            reasoningEfforts: [],
            inputModalities: model.inputModalities ?? ['text']
          }
        ])
      )
    );
  }
  configure(accepted, visible) {
    this.accepted = Object.fromEntries(Object.entries(accepted).filter(([, model]) => model.channelId));
    this.visible = Object.fromEntries(Object.entries(visible).filter(([, model]) => model.channelId));
  }
  bridge(channel) {
    let bridge = this.bridges.get(channel.id);
    if (!bridge) {
      const models = Object.fromEntries(
        Object.entries(this.accepted).filter(([, model]) => model.channelId === channel.id)
      );
      bridge = new this.Bridge({
        ...this.config,
        channels: [],
        mode: 'isolated',
        discoverModels: false,
        models,
        warmupModels: [],
        maxConcurrent: 0
      });
      this.bridges.set(channel.id, bridge);
    }
    return bridge;
  }
  async fetch(url, init, { owner, session }) {
    const body = JSON.parse(init.body);
    validateRequest(body, this.accepted);
    const model = this.accepted[body.model];
    const channel = this.channels.find((c) => c.id === model.channelId);
    if (!channel?.enabled) throw new ApiError('Upstream channel is disabled.', 403, 'model', 'channel_disabled');
    const excluded = new Set(),
      controller = new AbortController();
    const timeout = (ms, message) =>
      setTimeout(() => controller.abort(new ApiError(message, 504, null, 'channel_timeout')), ms);
    const first = timeout(this.config.firstOutputTimeoutMs, 'Channel first output deadline exceeded.');
    const total = this.config.timeoutMs
      ? timeout(this.config.timeoutMs, 'Channel request deadline exceeded.')
      : undefined;
    const signal = init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
    let lease,
      transferred = false,
      outputStarted = false;
    const release = () => {
      clearTimeout(first);
      clearTimeout(total);
      lease?.release();
    };
    try {
      for (let attempt = 0; attempt < channel.maxKeyAttempts; attempt++) {
        signal.throwIfAborted();
        lease = this.pool.acquire(channel, owner, session, excluded);
        const currentLease = lease;
        const response = await this.bridge(channel).fetch(
          url,
          {
            ...init,
            signal,
            onModelOutput: () => {
              outputStarted = true;
              clearTimeout(first);
            },
            onUpstreamError: (error) => this.pool.failure(channel, currentLease, error.status, error.headers)
          },
          lease.value
        );
        signal.throwIfAborted();
        if (!response.ok) {
          const error = await response
            .clone()
            .json()
            .catch(() => ({}));
          const retryable =
            response.status !== 403 &&
            [
              'upstream_rate_limit',
              'upstream_auth_error',
              'opencode_inference_error',
              'opencode_retry_exhausted'
            ].includes(error.error?.code);
          if (retryable) this.pool.failure(channel, lease, response.status, response.headers);
          if (retryable && !outputStarted && attempt + 1 < channel.maxKeyAttempts) {
            await response.body?.cancel();
            excluded.add(lease.token);
            lease.release();
            lease = undefined;
            continue;
          }
          release();
          return response;
        }
        clearTimeout(first);
        if (!response.body) {
          release();
          return response;
        }
        const reader = response.body.getReader();
        const body = new ReadableStream({
          async pull(out) {
            try {
              const next = await reader.read();
              if (next.done) {
                release();
                out.close();
              } else out.enqueue(next.value);
            } catch (error) {
              release();
              out.error(error);
            }
          },
          async cancel(reason) {
            try {
              await reader.cancel(reason);
            } finally {
              release();
            }
          }
        });
        transferred = true;
        return new Response(body, { status: response.status, headers: response.headers });
      }
    } finally {
      if (!transferred) release();
    }
  }
  async close() {
    await Promise.allSettled([...this.bridges.values()].map((bridge) => bridge.close()));
  }
}
