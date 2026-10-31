import { createHash } from 'node:crypto';

import { BuildError } from './errors.mjs';

export function normaliseExpressions(expressions) {
  if (!Array.isArray(expressions) || expressions.length === 0) {
    throw new BuildError('At least one filter expression is required');
  }

  const normalised = [];
  const seen = new Set();

  for (const entry of expressions) {
    if (typeof entry !== 'string') {
      throw new BuildError('Filter expressions must be strings');
    }

    const expression = entry.trim();
    if (expression === '') {
      throw new BuildError('Filter expressions must not be empty');
    }

    if (seen.has(expression)) {
      continue;
    }

    seen.add(expression);
    normalised.push(expression);
  }

  return normalised;
}

export function unionExpressions(groups) {
  const union = [];

  for (const group of groups) {
    union.push(...normaliseExpressions(group));
  }

  return normaliseExpressions(union);
}

export function renderExpressionsFile(expressions) {
  return `${normaliseExpressions(expressions).join('\n')}\n`;
}

export function hashExpressions(expressions) {
  const contents = renderExpressionsFile(expressions);
  return createHash('sha256').update(contents).digest('hex');
}
