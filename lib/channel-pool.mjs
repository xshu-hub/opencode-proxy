import { createHash } from 'node:crypto';
import { ApiError } from './protocol.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
export function channelSession(headers, body, previous) {
  const header = new Headers(headers).get('x-opencode-session-id');
  const metadata = body?.metadata?.session_id;
  const session = header ?? (metadata !== undefined ? metadata : previous);
  if (session !== undefined && (typeof session !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(session))) {
    throw new ApiError(
      'Session ID must contain 1–128 visible ASCII characters.',
      400,
      'metadata.session_id',
      'invalid_session_id'
    );
  }
  if (header !== null && metadata !== undefined && header !== metadata) {
    throw new ApiError('Header and metadata session IDs must match.', 400, 'metadata.session_id', 'invalid_session_id');
  }
  return session;
}

export class ChannelPool {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.channels = new Map();
    this.timer = setInterval(() => this.prune(), 60000);
    this.timer.unref();
  }
  state(channel) {
    let state = this.channels.get(channel.id);
    if (!state) {
      state = { cursor: 0, bindings: new Map(), keys: new Map(), ttl: channel.stickyTtlMs };
      this.channels.set(channel.id, state);
    }
    state.ttl = channel.stickyTtlMs;
    return state;
  }
  prune() {
    const now = this.now();
    // Acquire and completion move entries to the tail. Unexpired idle entries
    // therefore end this scan; active entries stay pinned even beyond the TTL.
    for (const state of this.channels.values())
      for (const [id, binding] of state.bindings) {
        if (binding.active) continue;
        if (binding.touched + state.ttl > now) break;
        state.bindings.delete(id);
      }
  }
  credentials(channel) {
    const state = this.state(channel),
      seen = new Set();
    const credentials = channel.keys
      .filter((k) => k.enabled)
      .flatMap((key) => {
        const value = key.key ?? process.env[key.apiKeyEnv];
        if (!value || !/^[\x21-\x7e]{1,4096}$/.test(value)) return [];
        const fingerprint = hash(value);
        if (seen.has(fingerprint)) return [];
        seen.add(fingerprint);
        const token = key.id + ':' + hash(JSON.stringify([channel.protocol, channel.baseURL, value]));
        let health = state.keys.get(token);
        if (!health) {
          health = { active: 0, until: 0, invalid: false };
          state.keys.set(token, health);
        }
        return [{ id: key.id, value, token, health }];
      });
    return credentials;
  }
  acquire(channel, owner, session, excluded = new Set()) {
    this.prune();
    const state = this.state(channel),
      credentials = this.credentials(channel),
      now = this.now();
    const bindingId = session ? hash(JSON.stringify([owner, session])) : undefined;
    let binding = state.bindings.get(bindingId);
    const usable = (key) => !excluded.has(key.token) && !key.health.invalid && key.health.until <= now;
    let selected = credentials.find((k) => k.token === binding?.token && usable(k));
    if (!selected) {
      for (let i = 0; i < credentials.length; i++) {
        const index = (state.cursor + i) % credentials.length;
        if (usable(credentials[index])) {
          selected = credentials[index];
          state.cursor = (index + 1) % credentials.length;
          break;
        }
      }
    }
    if (!selected) {
      const remaining = credentials.filter(
        (k) => !k.health.invalid && (k.health.until > now || !excluded.has(k.token))
      );
      const retry = remaining.length
        ? Math.max(1, Math.ceil((Math.min(...remaining.map((k) => k.health.until)) - now) / 1000))
        : undefined;
      const error = new ApiError(
        'No upstream channel Key is currently available.',
        remaining.length ? 429 : 503,
        null,
        'channel_keys_unavailable'
      );
      if (retry !== undefined) error.headers = { 'retry-after': String(retry) };
      throw error;
    }
    if (bindingId && !binding) {
      while (state.bindings.size >= channel.maxBindings) {
        let oldest;
        for (const entry of state.bindings)
          if (!entry[1].active) {
            oldest = entry;
            break;
          }
        if (!oldest)
          throw new ApiError(
            'Channel session binding capacity reached; retry later.',
            429,
            null,
            'channel_bindings_busy'
          );
        state.bindings.delete(oldest[0]);
      }
      binding = { token: selected.token, touched: now, active: 0 };
      state.bindings.set(bindingId, binding);
    }
    if (binding) {
      binding.token = selected.token;
      binding.touched = now;
      binding.active++;
      state.bindings.delete(bindingId);
      state.bindings.set(bindingId, binding);
    }
    selected.health.active++;
    let released = false;
    return {
      ...selected,
      release: () => {
        if (released) return;
        released = true;
        selected.health.active--;
        if (binding) {
          binding.active--;
          binding.touched = this.now();
          if (state.bindings.get(bindingId) === binding) {
            state.bindings.delete(bindingId);
            state.bindings.set(bindingId, binding);
          }
        }
      }
    };
  }
  failure(channel, lease, status, headers = {}) {
    if (status === 401) lease.health.invalid = true;
    else if (status === 429 || status >= 500) {
      const raw = new Headers(headers).get('retry-after');
      const ms = raw === null ? NaN : /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - this.now();
      lease.health.until = this.now() + Math.max(channel.cooldownMs, Number.isFinite(ms) ? Math.min(ms, 86400000) : 0);
    }
  }
  reconcile(channels) {
    const current = new Map(channels.map((c) => [c.id, c]));
    for (const [id, state] of this.channels) {
      const channel = current.get(id);
      if (!channel || !channel.enabled) {
        this.channels.delete(id);
        continue;
      }
      state.ttl = channel.stickyTtlMs;
      const tokens = new Set(this.credentials(channel).map((k) => k.token));
      for (const token of state.keys.keys()) if (!tokens.has(token)) state.keys.delete(token);
      for (const [id, binding] of state.bindings)
        if (!tokens.has(binding.token) && !binding.active) state.bindings.delete(id);
    }
    this.prune();
  }
  reset(channelId, keyId) {
    const state = this.channels.get(channelId);
    if (state)
      for (const [token, health] of state.keys)
        if (token.startsWith(keyId + ':')) {
          health.invalid = false;
          health.until = 0;
        }
  }
  summary(channels) {
    this.prune();
    return channels.map((channel) => {
      const state = this.state(channel),
        keys = this.credentials(channel);
      return {
        id: channel.id,
        bindings: state.bindings.size,
        keys: channel.keys.map((key) => {
          const health = keys.find((k) => k.id === key.id)?.health;
          return {
            id: key.id,
            status:
              !channel.enabled || !key.enabled
                ? 'disabled'
                : !health
                  ? 'missing'
                  : health.invalid
                    ? 'invalid'
                    : health.until > this.now()
                      ? 'cooling'
                      : 'ready',
            retryAt: health?.until > this.now() ? health.until : undefined,
            active: health?.active ?? 0
          };
        })
      };
    });
  }
  close() {
    clearInterval(this.timer);
    this.channels.clear();
  }
}
