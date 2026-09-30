// Attachment byte storage. Netlify Blobs in production; a local folder in development and tests.
// The database only stores metadata and the blob key.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { env } from './env.js';

export interface BlobStore {
  put(key: string, data: Uint8Array, meta: Record<string, string>): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

class FsBlobStore implements BlobStore {
  constructor(private root: string) {}
  private path(key: string) {
    if (!/^[a-zA-Z0-9/_.-]+$/.test(key) || key.includes('..')) throw new Error('Invalid blob key');
    return join(this.root, key);
  }
  async put(key: string, data: Uint8Array) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    try {
      return new Uint8Array(await readFile(this.path(key)));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    const { rm } = await import('node:fs/promises');
    await rm(this.path(key), { force: true });
  }
}

class NetlifyBlobStore implements BlobStore {
  private storePromise: Promise<any> | null = null;
  private store() {
    if (!this.storePromise) {
      this.storePromise = import('@netlify/blobs').then(({ getStore }) =>
        getStore({ name: 'attachments', consistency: 'strong' }),
      );
    }
    return this.storePromise;
  }
  async put(key: string, data: Uint8Array, meta: Record<string, string>) {
    const s = await this.store();
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await s.set(key, ab, { metadata: meta });
  }
  async get(key: string) {
    const s = await this.store();
    const ab: ArrayBuffer | null = await s.get(key, { type: 'arrayBuffer' });
    return ab ? new Uint8Array(ab) : null;
  }
  async delete(key: string) {
    const s = await this.store();
    await s.delete(key);
  }
}

let store: BlobStore | null = null;
export function getBlobStore(): BlobStore {
  if (!store) store = env.blobStore === 'netlify' ? new NetlifyBlobStore() : new FsBlobStore(resolve(env.blobDir));
  return store;
}

/** Tests can swap in a failing or in-memory store. */
export function setBlobStore(s: BlobStore | null) { store = s; }
