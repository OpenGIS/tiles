export class BuildError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'BuildError';
  }
}

export class BuildConfigError extends BuildError {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'BuildConfigError';
  }
}

export class CommandError extends BuildError {
  constructor(message, { command, exitCode, stderr, cause } = {}) {
    super(message, { cause });
    this.name = 'CommandError';
    this.command = command ?? null;
    this.exitCode = exitCode ?? null;
    this.stderr = stderr ?? null;
  }
}
