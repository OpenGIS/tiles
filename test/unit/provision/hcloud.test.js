import { describe, expect, it, vi } from 'vitest';

import { createHcloudClient, HcloudError } from '../../../src/provision/hcloud.mjs';

function mockResponse(body, { status = 200, statusText = 'OK', headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get(name) {
        return headers[name.toLowerCase()] ?? null;
      },
    },
    async text() {
      if (body === undefined || body === null) {
        return '';
      }

      return typeof body === 'string' ? body : JSON.stringify(body);
    },
  };
}

function clientWith(fetchImpl, options = {}) {
  return createHcloudClient({
    token: 'test-token',
    fetchImpl,
    retryDelayMs: 0,
    sleep: async () => {},
    ...options,
  });
}

const SERVER = {
  id: 42,
  name: 'ogis-tiles',
  status: 'running',
  public_net: {
    ipv4: { ip: '128.140.70.114' },
    ipv6: { ip: '2a01:4f8:1:2::/64' },
  },
  server_type: { name: 'cx23' },
  protection: { delete: false, rebuild: true },
};

describe('createHcloudClient', () => {
  it('requires a token', () => {
    expect(() => createHcloudClient({ token: '' })).toThrow(/HCLOUD_TOKEN is required/);
  });

  it('sends bearer auth, JSON bodies and returns the action', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        action: { id: 9, status: 'running' },
        root_password: 'must-not-leak',
      }),
    );
    const client = clientWith(fetchImpl);

    const action = await client.rebuildServer(42, {
      image: 387894169,
      userData: '#cloud-config\n',
    });

    expect(action).toEqual({ id: 9, status: 'running' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.hetzner.cloud/v1/servers/42/actions/rebuild');
    expect(options.method).toBe('POST');
    expect(options.headers.Authorization).toBe('Bearer test-token');
    expect(options.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(options.body)).toEqual({
      image: 387894169,
      user_data: '#cloud-config\n',
    });
  });

  it('finds a server through its primary IP first', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const pathname = new URL(url).pathname;

      if (pathname === '/v1/primary_ips') {
        return mockResponse({
          primary_ips: [{ ip: '128.140.70.114', assignee_id: 42, assignee_type: 'server' }],
        });
      }

      if (pathname === '/v1/servers/42') {
        return mockResponse({ server: SERVER });
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const server = await clientWith(fetchImpl).findServerByIPv4('128.140.70.114');

    expect(server).toEqual(SERVER);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('ip')).toBe('128.140.70.114');
  });

  it('falls back to paginated servers when the primary IP is unassigned', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/v1/primary_ips') {
        return mockResponse({ primary_ips: [] });
      }

      if (parsed.pathname === '/v1/servers') {
        const page = parsed.searchParams.get('page');

        if (page === '1') {
          return mockResponse({
            servers: [{ ...SERVER, id: 1, public_net: { ipv4: { ip: '192.0.2.1' } } }],
            meta: { pagination: { next_page: 2 } },
          });
        }

        return mockResponse({
          servers: [SERVER],
          meta: { pagination: { next_page: null } },
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });

    const server = await clientWith(fetchImpl).findServerByIPv4('128.140.70.114');

    expect(server).toEqual(SERVER);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns null when no server matches the IP', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/v1/primary_ips') {
        return mockResponse({ primary_ips: [] });
      }

      return mockResponse({ servers: [], meta: { pagination: { next_page: null } } });
    });

    await expect(clientWith(fetchImpl).findServerByIPv4('198.51.100.1')).resolves.toBeNull();
  });

  it('finds a server by exact name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        servers: [{ ...SERVER, name: 'other' }, SERVER],
      }),
    );

    const server = await clientWith(fetchImpl).findServerByName('ogis-tiles');

    expect(server).toEqual(SERVER);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get('name')).toBe('ogis-tiles');
  });

  it('looks up a system x86 image by name', async () => {
    const image = {
      id: 387894169,
      name: 'ubuntu-26.04',
      type: 'system',
      architecture: 'x86',
      status: 'available',
    };
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse({ images: [image] }));

    const result = await clientWith(fetchImpl).findImageByName('ubuntu-26.04');

    expect(result).toEqual(image);

    const parsed = new URL(fetchImpl.mock.calls[0][0]);
    expect(parsed.pathname).toBe('/v1/images');
    expect(parsed.searchParams.get('name')).toBe('ubuntu-26.04');
    expect(parsed.searchParams.get('type')).toBe('system');
    expect(parsed.searchParams.get('architecture')).toBe('x86');
    expect(parsed.searchParams.get('status')).toBe('available');
  });

  it('never falls back to a different image name or architecture', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        images: [
          {
            id: 1,
            name: 'debian-12',
            type: 'system',
            architecture: 'x86',
            status: 'available',
          },
        ],
      }),
    );

    await expect(clientWith(fetchImpl).findImageByName('ubuntu-26.04', 'x86')).resolves.toBeNull();
  });

  it('rejects an image whose architecture does not match the request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        images: [
          {
            id: 1,
            name: 'ubuntu-26.04',
            type: 'system',
            architecture: 'arm',
            status: 'available',
          },
        ],
      }),
    );

    await expect(clientWith(fetchImpl).findImageByName('ubuntu-26.04', 'x86')).resolves.toBeNull();
  });

  it('creates a build server without returning the root password', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        server: SERVER,
        action: { id: 9, status: 'running' },
        root_password: 'must-not-leak',
      }),
    );
    const client = clientWith(fetchImpl);

    const result = await client.createServer({
      name: 'ogis-build-test',
      serverType: 'cpx62',
      location: 'nbg1',
      image: 'ubuntu-26.04',
      userData: '#cloud-config\n',
      labels: { role: 'build-box' },
    });

    expect(result).toEqual({ server: SERVER, action: { id: 9, status: 'running' } });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/servers');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      name: 'ogis-build-test',
      server_type: 'cpx62',
      location: 'nbg1',
      image: 'ubuntu-26.04',
      user_data: '#cloud-config\n',
      start_after_create: true,
      labels: { role: 'build-box' },
    });
  });

  it('includes registered recovery SSH keys in the create request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        server: SERVER,
        action: { id: 9, status: 'running' },
      }),
    );
    const client = clientWith(fetchImpl);

    await client.createServer({
      name: 'ogis-build-test',
      serverType: 'cpx62',
      location: 'nbg1',
      image: 'ubuntu-26.04',
      userData: '#cloud-config\n',
      sshKeys: [7],
    });

    const [, options] = fetchImpl.mock.calls[0];
    expect(JSON.parse(options.body).ssh_keys).toEqual([7]);
  });

  it('lists and creates SSH keys for the recovery path', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      const parsed = new URL(url);

      if (parsed.pathname === '/v1/ssh_keys' && options.method === 'GET') {
        return mockResponse({
          ssh_keys: [{ id: 7, name: 'existing', public_key: 'ssh-ed25519 AAAA existing' }],
          meta: { pagination: { next_page: null } },
        });
      }

      if (parsed.pathname === '/v1/ssh_keys' && options.method === 'POST') {
        return mockResponse({
          ssh_key: { id: 8, name: 'ogis-tiles-deploy', public_key: 'ssh-ed25519 BBBB new' },
        });
      }

      throw new Error(`Unexpected URL ${url}`);
    });
    const client = clientWith(fetchImpl);

    await expect(client.listSshKeys()).resolves.toHaveLength(1);
    await expect(
      client.createSshKey({ name: 'ogis-tiles-deploy', publicKey: 'ssh-ed25519 BBBB new' }),
    ).resolves.toMatchObject({ id: 8 });

    const [, options] = fetchImpl.mock.calls[1];
    expect(JSON.parse(options.body)).toEqual({
      name: 'ogis-tiles-deploy',
      public_key: 'ssh-ed25519 BBBB new',
    });
  });

  it('validates the inputs needed to create a server', async () => {
    const client = clientWith(vi.fn());

    await expect(client.createServer({ name: 'x' })).rejects.toThrow(/server type is required/);
    await expect(
      client.createServer({ name: 'x', serverType: 'cpx62', location: 'nbg1', image: 'x' }),
    ).rejects.toThrow(/user_data is required/);
  });

  it('deletes a server by id and validates the id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ action: { id: 10, status: 'running' } }));
    const client = clientWith(fetchImpl);

    await expect(client.deleteServer(42)).resolves.toEqual({ id: 10, status: 'running' });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/servers/42');
    expect(options.method).toBe('DELETE');

    await expect(client.deleteServer('42')).rejects.toThrow(/positive server id/);
  });

  it('polls an action until it succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ action: { id: 7, status: 'running' } }))
      .mockResolvedValueOnce(mockResponse({ action: { id: 7, status: 'success' } }));

    const action = await clientWith(fetchImpl).waitForAction(7, {
      timeoutMs: 1_000,
      intervalMs: 0,
    });

    expect(action.status).toBe('success');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new URL(fetchImpl.mock.calls[0][0]).pathname).toBe('/v1/actions/7');
  });

  it('reports a failed action without exposing the whole response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      mockResponse({
        action: {
          id: 7,
          status: 'error',
          error: { code: 'action_failed', message: 'rebuild failed' },
        },
      }),
    );

    await expect(
      clientWith(fetchImpl).waitForAction(7, { timeoutMs: 1_000, intervalMs: 0 }),
    ).rejects.toMatchObject({
      name: 'HcloudError',
      code: 'action_failed',
    });
  });

  it('times out while waiting for an action', async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ action: { id: 7, status: 'running' } }));
    const client = clientWith(fetchImpl, {
      now: () => clock,
      sleep: async () => {
        clock += 1_000;
      },
    });

    await expect(client.waitForAction(7, { timeoutMs: 2_000, intervalMs: 1_000 })).rejects.toThrow(
      /Timed out after 2000ms/,
    );
  });

  it('retries 5xx responses a bounded number of times', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ error: { message: 'unavailable' } }, { status: 503 }))
      .mockResolvedValueOnce(mockResponse({ error: { message: 'unavailable' } }, { status: 500 }))
      .mockResolvedValueOnce(mockResponse({ server: SERVER }));

    const server = await clientWith(fetchImpl, { maxRetries: 2 }).getServer(42);

    expect(server).toEqual(SERVER);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('stops retrying after the configured limit and keeps the status', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ error: { message: 'rate limited' } }, { status: 429 }));

    await expect(clientWith(fetchImpl, { maxRetries: 1 }).getServer(42)).rejects.toMatchObject({
      name: 'HcloudError',
      status: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('reports malformed JSON clearly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse('not-json'));

    await expect(clientWith(fetchImpl).getServer(42)).rejects.toThrow(/invalid JSON/);
  });

  it('maps an aborted request to a timeout error', async () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    const fetchImpl = vi.fn().mockRejectedValue(error);

    await expect(clientWith(fetchImpl, { timeoutMs: 50 }).getServer(42)).rejects.toThrow(
      /timed out after 50ms/,
    );
  });

  it('keeps delete and rebuild protection values in step', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ action: { id: 3, status: 'running' } }));
    const client = clientWith(fetchImpl);

    await client.changeProtection(42, { delete: false, rebuild: false });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/servers/42/actions/change_protection');
    expect(JSON.parse(options.body)).toEqual({ delete: false, rebuild: false });
  });

  it('creates a snapshot through the create_image action', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(mockResponse({ action: { id: 5, status: 'running' }, image: { id: 11 } }));

    const result = await clientWith(fetchImpl).createSnapshot(42, 'pre-rebuild');

    expect(result).toEqual({ action: { id: 5, status: 'running' }, image: { id: 11 } });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/servers/42/actions/create_image');
    expect(JSON.parse(options.body)).toEqual({ type: 'snapshot', description: 'pre-rebuild' });
  });

  it('paginates primary IPs and filters by the supported fields', async () => {
    const fetchImpl = vi.fn(async (url) => {
      const parsed = new URL(url);
      const page = parsed.searchParams.get('page');

      if (page === '1') {
        return mockResponse({
          primary_ips: [
            { ip: '192.0.2.1', assignee_id: 1 },
            { ip: '128.140.70.114', assignee_id: 42 },
          ],
          meta: { pagination: { next_page: 2 } },
        });
      }

      return mockResponse({
        primary_ips: [{ ip: '192.0.2.2', assignee_id: 2 }],
        meta: { pagination: { next_page: null } },
      });
    });

    const primaryIps = await clientWith(fetchImpl).getPrimaryIPs(42);

    expect(primaryIps).toEqual([{ ip: '128.140.70.114', assignee_id: 42 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    for (const [url] of fetchImpl.mock.calls) {
      const parsed = new URL(url);
      expect(parsed.searchParams.has('assignee_id')).toBe(false);
      expect(parsed.searchParams.get('per_page')).toBe('50');
    }
  });

  it('enables rescue without logging secrets', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        mockResponse({ action: { id: 6, status: 'running' }, root_password: 'secret' }),
      );
    const client = clientWith(fetchImpl);

    await expect(client.enableRescue(42, { sshKeys: [7] })).resolves.toEqual({
      action: { id: 6, status: 'running' },
      rootPassword: 'secret',
    });

    const [url, options] = fetchImpl.mock.calls[0];
    expect(new URL(url).pathname).toBe('/v1/servers/42/actions/enable_rescue');
    expect(JSON.parse(options.body)).toEqual({ type: 'linux64', ssh_keys: [7] });
  });

  it('never retries a destructive POST', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ error: { message: 'unavailable' } }, { status: 500 }))
      .mockResolvedValueOnce(mockResponse({ action: { id: 9, status: 'running' } }));

    await expect(
      clientWith(fetchImpl).rebuildServer(42, {
        image: 387894169,
        userData: '#cloud-config\n',
      }),
    ).rejects.toMatchObject({ status: 500 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps a huge Retry-After header', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        mockResponse(
          { error: { message: 'rate limited' } },
          { status: 429, headers: { 'retry-after': '999999' } },
        ),
      )
      .mockResolvedValueOnce(mockResponse({ server: SERVER }));

    const client = clientWith(fetchImpl, { sleep });
    await expect(client.getServer(42)).resolves.toEqual(SERVER);

    expect(sleep).toHaveBeenCalledWith(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops when the total retry budget is exhausted', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          { error: { message: 'rate limited' } },
          { status: 429, headers: { 'retry-after': '60' } },
        ),
      );

    await expect(clientWith(fetchImpl, { maxRetryTotalMs: 1_000 }).getServer(42)).rejects.toThrow(
      /retry budget exhausted/,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('times out a slow response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: {
        get() {
          return null;
        },
      },
      text() {
        return new Promise(() => {});
      },
    });

    await expect(clientWith(fetchImpl, { timeoutMs: 20 }).getServer(42)).rejects.toThrow(
      /timed out after 20ms/,
    );
  });

  it('rejects an oversized response body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(mockResponse('x'.repeat(200)));

    await expect(clientWith(fetchImpl, { maxResponseBytes: 100 }).getServer(42)).rejects.toThrow(
      /exceeded the 100-byte limit/,
    );
  });

  it('redacts the bearer token from error messages', async () => {
    const token = 'super-secret-token';
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        mockResponse(
          { error: { message: `request used ${token}` } },
          { status: 400, statusText: 'Bad Request' },
        ),
      );

    const client = createHcloudClient({ token, fetchImpl });
    const error = await client.getServer(42).catch((caught) => caught);

    expect(error.message).not.toContain(token);
    expect(error.message).toContain('[REDACTED]');
  });

  it('exports a typed error', () => {
    expect(new HcloudError('failed')).toBeInstanceOf(Error);
  });
});
