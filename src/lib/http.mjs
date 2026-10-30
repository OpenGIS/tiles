const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-expose-headers': 'ETag, Content-Length, Content-Encoding',
};

export function sendJson(request, response, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    ...extraHeaders,
    ...CORS_HEADERS,
  };

  response.writeHead(status, headers);

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  response.end(payload);
}

export function sendEmpty(request, response, status, extraHeaders = {}) {
  response.writeHead(status, {
    ...extraHeaders,
    ...CORS_HEADERS,
  });
  response.end();
}

export function sendTile(request, response, tile, headers) {
  response.writeHead(200, {
    'content-type': 'application/x-protobuf',
    ...headers,
    'content-length': String(tile.length),
    ...CORS_HEADERS,
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  response.end(tile);
}
