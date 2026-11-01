import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { javaVersionArgs, osmiumVersionArgs, pmtilesVersionArgs } from './commands.mjs';
import { BuildError } from './errors.mjs';
import { md5File, pathExists, sha256File } from './fs.mjs';
import { runCommand } from './exec.mjs';

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PLANETILER_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export async function downloadFile({
  url,
  destination,
  expectedSha256 = '',
  expectedMd5 = '',
  fetchImpl = fetch,
}) {
  if (!url) {
    throw new BuildError('A download URL is required');
  }

  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.part`;

  try {
    const response = await fetchImpl(url, { redirect: 'follow' });
    if (!response.ok || !response.body) {
      throw new BuildError(`Download failed for ${url}: HTTP ${response.status}`);
    }

    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    const digest = await sha256File(temporary);

    if (expectedSha256 && digest !== expectedSha256.toLowerCase()) {
      throw new BuildError(
        `Checksum mismatch for ${path.basename(destination)}: expected ${expectedSha256}, received ${digest}`,
      );
    }

    if (expectedMd5) {
      const md5 = await md5File(temporary);

      if (md5 !== expectedMd5.toLowerCase()) {
        throw new BuildError(
          `MD5 checksum mismatch for ${path.basename(destination)}: expected ${expectedMd5}, received ${md5}`,
        );
      }
    }

    await rename(temporary, destination);
    return digest;
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function validatePlanetiler(planetiler) {
  const version = planetiler?.version;
  if (!version) {
    throw new BuildError('No Planetiler version is configured');
  }

  if (typeof version !== 'string' || !PLANETILER_VERSION_PATTERN.test(version)) {
    throw new BuildError(
      'Planetiler version contains unsupported characters; use letters, digits, dots, underscores and dashes only',
    );
  }

  const url = typeof planetiler.url === 'string' ? planetiler.url.trim() : '';
  const sha256 =
    typeof planetiler.sha256 === 'string' ? planetiler.sha256.trim().toLowerCase() : '';

  if (url !== '' && sha256 === '') {
    throw new BuildError('A pinned Planetiler SHA-256 is required whenever a download URL is set');
  }

  if (sha256 !== '' && !SHA256_PATTERN.test(sha256)) {
    throw new BuildError('The pinned Planetiler SHA-256 must be a lowercase 64 character digest');
  }

  return { version, url, sha256 };
}

export async function ensurePlanetiler({ planetiler, toolsDir, fetchImpl = fetch, force = false }) {
  const resolved = validatePlanetiler(planetiler);
  const jarPath = path.join(toolsDir, `planetiler-${resolved.version}.jar`);
  const cached = await pathExists(jarPath);
  const cachedSha256 = cached ? await sha256File(jarPath) : '';

  if (cached && resolved.sha256 !== '' && cachedSha256 === resolved.sha256 && !force) {
    return { path: jarPath, sha256: cachedSha256, version: resolved.version };
  }

  if (cached && resolved.sha256 === '') {
    throw new BuildError(
      `Refusing to execute the unverified Planetiler jar at ${jarPath}; configure a pinned SHA-256`,
    );
  }

  if (cached && cachedSha256 !== resolved.sha256 && !force) {
    throw new BuildError(
      `Planetiler ${resolved.version} at ${jarPath} has the wrong checksum; use --force to download it again`,
    );
  }

  if (resolved.url === '') {
    if (cached && resolved.sha256 !== '' && cachedSha256 === resolved.sha256) {
      throw new BuildError(
        `Planetiler ${resolved.version} is cached at ${jarPath} but --force was requested and no download URL is configured`,
      );
    }

    if (resolved.sha256 === '') {
      throw new BuildError(
        `Planetiler ${resolved.version} is not cached and no download URL is configured`,
      );
    }

    throw new BuildError(
      `Planetiler ${resolved.version} is not cached at ${jarPath} and no download URL is configured`,
    );
  }

  const downloadPath = `${jarPath}.${process.pid}.download`;

  try {
    const sha256 = await downloadFile({
      url: resolved.url,
      destination: downloadPath,
      expectedSha256: resolved.sha256,
      fetchImpl,
    });

    if (sha256 !== resolved.sha256) {
      throw new BuildError(
        `Planetiler ${resolved.version} failed checksum verification after download`,
      );
    }

    await rename(downloadPath, jarPath);
    return { path: jarPath, sha256, version: resolved.version };
  } catch (error) {
    await rm(downloadPath, { force: true }).catch(() => {});
    throw error;
  }
}

export function parseJavaMajorVersion(version) {
  const match = /^(\d+)(?:\.(\d+))?/.exec(String(version).trim());
  if (!match) {
    throw new BuildError(`Unable to determine the Java major version from "${version}"`);
  }

  const first = Number(match[1]);
  if (first === 1 && match[2] !== undefined) {
    return Number(match[2]);
  }

  return first;
}

export async function detectJavaVersion({ execFileImpl } = {}) {
  const { stdout, stderr } = await runCommand('java', javaVersionArgs(), { execFileImpl });
  const output = `${stdout}\n${stderr}`;
  const match = /version "([^"]+)"/.exec(output);

  if (!match) {
    throw new BuildError('Unable to determine the local Java version');
  }

  const version = match[1];
  const major = parseJavaMajorVersion(version);

  if (major < 21) {
    throw new BuildError(`Java ${version} is too old; Planetiler requires Java 21 or newer`);
  }

  return version;
}

export async function detectOsmiumVersion({ execFileImpl } = {}) {
  const { stdout, stderr } = await runCommand('osmium', osmiumVersionArgs(), { execFileImpl });
  const output = `${stdout}\n${stderr}`;
  const match = /^osmium version (\S+)$/m.exec(output);

  if (!match) {
    throw new BuildError('Unable to determine the local osmium version');
  }

  return match[1];
}

export async function resolveExecutable(command, { execFileImpl } = {}) {
  let stdout;

  try {
    ({ stdout } = await runCommand('which', [command], { execFileImpl }));
  } catch (error) {
    throw new BuildError(`Unable to locate the ${command} executable on PATH`, { cause: error });
  }

  const executable = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');

  if (!executable) {
    throw new BuildError(`Unable to locate the ${command} executable on PATH`);
  }

  return executable;
}

export async function detectPmtiles({ execFileImpl } = {}) {
  const { stdout, stderr } = await runCommand('pmtiles', pmtilesVersionArgs(), { execFileImpl });
  const output = `${stdout}\n${stderr}`.trim();
  const match = /^pmtiles\s+(?:version\s+)?v?([^,\s]+)/m.exec(output);

  if (!match) {
    throw new BuildError('Unable to determine the local pmtiles version');
  }

  const executable = await resolveExecutable('pmtiles', { execFileImpl });

  return {
    version: match[1],
    sha256: await sha256File(executable),
  };
}
