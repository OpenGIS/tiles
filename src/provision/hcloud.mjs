// Zero-dependency Hetzner Cloud REST client.
//
// The npm package `hcloud@1.0.2` is a deprecated stub that exports a single string, so this module
// talks to the REST API directly with Node's built-in fetch instead of depending on an SDK. Keeping
// the client small also makes every request injectable in tests.

const DEFAULT_BASE_URL = 'https://api.hetzner.cloud/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_MAX_RETRY_TOTAL_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const RETRYABLE_METHODS = new Set(['GET', 'HEAD']);

export class HcloudError extends Error {
  constructor(message, { status = null, code = null, cause } = {}) {
    super(message, { cause });
    this.name = 'HcloudError';
    this.status = status;
    this.code = code;
  }
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function isRetryableStatus(status) {
  return status === 429 || status >= 500;
}

function isRetryableMethod(method) {
  return RETRYABLE_METHODS.has(String(method).toUpperCase());
}

function retryDelay(response, attempt, baseDelayMs) {
  const header = response.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1_000;
    }

    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.max(0, date - Date.now());
    }
  }

  return baseDelayMs * 2 ** attempt;
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function awaitWithAbort(promise, signal) {
  if (!signal) {
    return Promise.resolve(promise);
  }

  if (signal.aborted) {
    return Promise.reject(abortError());
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(abortError());
    };

    signal.addEventListener('abort', onAbort, { once: true });

    Promise.resolve(promise).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseText(response, { signal, maxBytes }) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const text = await awaitWithAbort(
      Promise.resolve().then(() => response.text()),
      signal,
    );
    if (text === undefined || text === null || text === '') {
      return '';
    }

    const value = String(text);
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      throw new HcloudError(`Hetzner Cloud API response exceeded the ${maxBytes}-byte limit`);
    }

    return value;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';

  for (;;) {
    const { done, value } = await awaitWithAbort(reader.read(), signal);
    if (done) {
      return text + decoder.decode();
    }

    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed; the size error below is what matters.
      }

      throw new HcloudError(`Hetzner Cloud API response exceeded the ${maxBytes}-byte limit`);
    }

    text += decoder.decode(value, { stream: true });
  }
}

function errorDetail(status, statusText, text) {
  let code = null;
  let message = '';

  try {
    const body = JSON.parse(text);
    code = body?.error?.code ?? null;
    message = body?.error?.message ?? '';
  } catch {
    // Ignore a non-JSON error body. Never echo the body itself because it may contain secrets.
  }

  const detail = message || statusText || 'request failed';
  return { code, message: `Hetzner Cloud API returned HTTP ${status}: ${detail}` };
}

export function createHcloudClient({
  token,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
  maxRetryTotalMs = DEFAULT_MAX_RETRY_TOTAL_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  if (typeof token !== 'string' || token.trim() === '') {
    throw new HcloudError('HCLOUD_TOKEN is required to talk to the Hetzner Cloud API');
  }

  if (typeof fetchImpl !== 'function') {
    throw new HcloudError('A fetch implementation is required to talk to the Hetzner Cloud API');
  }

  const apiBase = String(baseUrl).replace(/\/+$/, '');
  const secret = token.trim();

  function redact(value) {
    return String(value).split(secret).join('[REDACTED]');
  }

  function fail(message, options = {}) {
    return new HcloudError(redact(message), options);
  }

  function requestUrl(pathname, query) {
    const url = new URL(`${apiBase}${pathname}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  async function request(method, pathname, { body, query } = {}) {
    const url = requestUrl(pathname, query);
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    let attempt = 0;
    const retryStartedAt = now();

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();

      let response;
      let text = '';
      try {
        response = await fetchImpl(url.toString(), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: controller.signal,
        });

        text = await readResponseText(response, {
          signal: controller.signal,
          maxBytes: maxResponseBytes,
        });
      } catch (error) {
        if (error instanceof HcloudError) {
          throw error;
        }

        if (error?.name === 'AbortError') {
          throw fail(
            `Hetzner Cloud request timed out after ${timeoutMs}ms (${method} ${pathname})`,
            { cause: error },
          );
        }

        throw fail(
          `Hetzner Cloud request failed (${method} ${pathname}): ${error?.message ?? 'network error'}`,
          { cause: error },
        );
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 204) {
        return null;
      }

      if (response.ok) {
        if (text === '') {
          return null;
        }

        try {
          return JSON.parse(text);
        } catch (error) {
          throw fail('Hetzner Cloud API returned invalid JSON', { cause: error });
        }
      }

      if (isRetryableMethod(method) && isRetryableStatus(response.status) && attempt < maxRetries) {
        const delay = Math.min(retryDelay(response, attempt, retryDelayMs), maxRetryAfterMs);
        if (now() - retryStartedAt + delay > maxRetryTotalMs) {
          throw fail(
            `Hetzner Cloud retry budget exhausted after ${maxRetryTotalMs}ms (${method} ${pathname})`,
            { status: response.status },
          );
        }

        attempt += 1;
        await sleep(delay);
        continue;
      }

      const detail = errorDetail(response.status, response.statusText, text);
      throw fail(`${detail.message} (${method} ${pathname})`, {
        status: response.status,
        code: detail.code,
      });
    }
  }

  async function getServer(id) {
    const data = await request('GET', `/servers/${id}`);
    return data?.server ?? null;
  }

  async function listServersPage({ page = 1, perPage = 50, name } = {}) {
    const data = await request('GET', '/servers', {
      query: { page, per_page: perPage, name },
    });

    return {
      servers: data?.servers ?? [],
      nextPage: data?.meta?.pagination?.next_page ?? null,
    };
  }

  async function findServerByIPv4(ip) {
    const primary = await request('GET', '/primary_ips', { query: { ip } });
    const assigned = (primary?.primary_ips ?? []).find(
      (primaryIp) => primaryIp.ip === ip && primaryIp.assignee_id,
    );

    if (assigned) {
      try {
        const server = await getServer(assigned.assignee_id);
        if (server) {
          return server;
        }
      } catch (error) {
        if (error?.status !== 404) {
          throw error;
        }
      }
    }

    let page = 1;
    for (;;) {
      const { servers, nextPage } = await listServersPage({ page });
      const match = servers.find((server) => server.public_net?.ipv4?.ip === ip);
      if (match) {
        return match;
      }

      if (!nextPage) {
        return null;
      }

      page = nextPage;
    }
  }

  async function findServerByName(name) {
    const data = await request('GET', '/servers', { query: { name } });
    const match = (data?.servers ?? []).find((server) => server.name === name);
    return match ?? null;
  }

  async function findImageByName(name, architecture = 'x86') {
    const data = await request('GET', '/images', {
      query: {
        name,
        type: 'system',
        architecture,
        status: 'available',
      },
    });

    const images = data?.images ?? [];
    return (
      images.find(
        (image) =>
          image.name === name &&
          image.architecture === architecture &&
          image.type === 'system' &&
          image.status === 'available',
      ) ?? null
    );
  }

  async function rebuildServer(id, { image, userData } = {}) {
    if (image === undefined || image === null || image === '') {
      throw fail('An image is required to rebuild a server');
    }

    if (typeof userData !== 'string' || userData.trim() === '') {
      throw fail('Cloud-init user_data is required to rebuild a server');
    }

    const data = await request('POST', `/servers/${id}/actions/rebuild`, {
      body: { image, user_data: userData },
    });

    // The response may include root_password. It is deliberately discarded: the rebuild installs
    // the deploy key through cloud-init, and secrets must never reach logs or the terminal.
    return data?.action ?? null;
  }

  async function waitForAction(
    actionId,
    { timeoutMs: actionTimeoutMs = 600_000, intervalMs = 3_000 } = {},
  ) {
    const deadline = now() + actionTimeoutMs;

    for (;;) {
      const data = await request('GET', `/actions/${actionId}`);
      const action = data?.action;

      if (!action) {
        throw fail(`Hetzner Cloud action ${actionId} was not returned`);
      }

      if (action.status === 'success') {
        return action;
      }

      if (action.status === 'error') {
        const detail = action.error?.message ?? 'unknown error';
        throw fail(`Hetzner Cloud action ${actionId} failed: ${detail}`, {
          code: action.error?.code ?? null,
        });
      }

      if (now() >= deadline) {
        throw fail(
          `Timed out after ${actionTimeoutMs}ms waiting for Hetzner Cloud action ${actionId}`,
        );
      }

      await sleep(intervalMs);
    }
  }

  async function changeProtection(id, { delete: deleteProtection = false, rebuild = false } = {}) {
    // Hetzner requires `delete` and `rebuild` to carry the same value. Callers must therefore pass
    // both when disabling rebuild protection.
    const data = await request('POST', `/servers/${id}/actions/change_protection`, {
      body: {
        delete: Boolean(deleteProtection),
        rebuild: Boolean(rebuild),
      },
    });

    return data?.action ?? null;
  }

  async function createSnapshot(id, description) {
    const data = await request('POST', `/servers/${id}/actions/create_image`, {
      body: { type: 'snapshot', description },
    });

    return { action: data?.action ?? null, image: data?.image ?? null };
  }

  async function getPrimaryIPs(serverId) {
    const primaryIps = [];
    let page = 1;

    for (;;) {
      const data = await request('GET', '/primary_ips', {
        query: { page, per_page: 50 },
      });

      primaryIps.push(...(data?.primary_ips ?? []));
      const nextPage = data?.meta?.pagination?.next_page ?? null;
      if (!nextPage) {
        return primaryIps.filter((primaryIp) => primaryIp.assignee_id === serverId);
      }

      page = nextPage;
    }
  }

  async function enableRescue(id, { sshKeys = [], type = 'linux64' } = {}) {
    const data = await request('POST', `/servers/${id}/actions/enable_rescue`, {
      body: { type, ssh_keys: sshKeys },
    });

    // root_password is a secret. Return it only to an explicit caller and never log it.
    return { action: data?.action ?? null, rootPassword: data?.root_password ?? null };
  }

  async function disableRescue(id) {
    const data = await request('POST', `/servers/${id}/actions/disable_rescue`);
    return data?.action ?? null;
  }

  async function detachIso(id) {
    const data = await request('POST', `/servers/${id}/actions/detach_iso`);
    return data?.action ?? null;
  }

  async function listServerActions(id, { status } = {}) {
    const actions = [];
    let page = 1;

    for (;;) {
      const data = await request('GET', `/servers/${id}/actions`, {
        query: { page, status },
      });

      actions.push(...(data?.actions ?? []));
      const nextPage = data?.meta?.pagination?.next_page ?? null;
      if (!nextPage) {
        return actions;
      }

      page = nextPage;
    }
  }

  return {
    findServerByIPv4,
    findServerByName,
    getServer,
    findImageByName,
    rebuildServer,
    waitForAction,
    changeProtection,
    createSnapshot,
    getPrimaryIPs,
    enableRescue,
    disableRescue,
    detachIso,
    listServerActions,
  };
}
