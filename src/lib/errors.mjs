export class SourceUnavailableError extends Error {
  constructor(message, { retryAfter = null, cause } = {}) {
    super(message, { cause });
    this.name = 'SourceUnavailableError';
    this.retryAfter = Number.isInteger(retryAfter) && retryAfter > 0 ? retryAfter : null;
    this.statusCode = 503;
  }
}

export class DemDecodeError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'DemDecodeError';
    this.statusCode = 500;
  }
}

export class DemCoverageError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'DemCoverageError';
    this.statusCode = 204;
  }
}
