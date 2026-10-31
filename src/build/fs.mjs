import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

export async function fileSize(target) {
  return (await stat(target)).size;
}

export async function sha256File(target) {
  const hash = createHash('sha256');

  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

export function sha256Text(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

export async function writeJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function removePath(target) {
  await rm(target, { recursive: true, force: true });
}

export async function replaceFile(source, target) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await copyFile(source, temporary);
  await rename(temporary, target);
}

export async function preservePrevious(target, previous) {
  if (!(await pathExists(target))) {
    return false;
  }

  await rm(previous, { force: true });
  await copyFile(target, previous);
  return true;
}
