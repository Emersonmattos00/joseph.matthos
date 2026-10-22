// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storage = require('../api/_storage.js');

function setB2Env({
  region = 'us-east-005',
  keyId = 'key-id',
  appKey = 'application-key',
  imageBucket = 'joseph.matthos',
  audioBucket = 'josephmatthos',
  endpoint = 'https://s3.us-east-005.backblazeb2.com',
  imagePublicUrl = 'https://f005.backblazeb2.com/file/joseph.matthos'
} = {}) {
  vi.stubEnv('B2_MEDIA_REGION', region);
  vi.stubEnv('B2_KEY_ID', keyId);
  vi.stubEnv('B2_APPLICATION_KEY', appKey);
  vi.stubEnv('B2_IMAGE_BUCKET', imageBucket);
  vi.stubEnv('B2_AUDIO_BUCKET', audioBucket);
  vi.stubEnv('B2_MEDIA_BUCKET', audioBucket); // fallback legado, lido por getPublicUrl e scripts de sync
  vi.stubEnv('B2_MEDIA_ENDPOINT', endpoint);
  vi.stubEnv('B2_IMAGE_PUBLIC_URL', imagePublicUrl);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('B2 storage configuration', () => {
  it('requires B2 credentials and region', () => {
    vi.stubEnv('B2_MEDIA_REGION', '');
    vi.stubEnv('B2_KEY_ID', '');
    vi.stubEnv('B2_APPLICATION_KEY', '');

    expect(() => storage.getStorageConfig()).toThrow('Backblaze B2 não configurado.');
  });

  it('uses the regional B2 endpoints and configured bucket names', () => {
    setB2Env({
      region: 'us-east-005',
      keyId: 'key-id',
      appKey: 'application-key'
    });

    expect(storage.getStorageConfig()).toMatchObject({
      endpoint: 'https://s3.us-east-005.backblazeb2.com',
      publicBaseUrl: 'https://f005.backblazeb2.com/file'
    });
    expect(storage.getBucketForKind('image')).toBe('joseph.matthos');
    expect(storage.getBucketForKind('audio-preview')).toBe('josephmatthos');
    expect(storage.getBucketForKind('audio-full')).toBe('josephmatthos');
  });

  it('uses the configured image URL and preserves nested object paths', () => {
    setB2Env({
      region: 'us-east-005',
      keyId: 'key-id',
      appKey: 'application-key',
      imagePublicUrl: 'https://f005.backblazeb2.com/file/josephmatthos'
    });

    expect(storage.getPublicUrl('josephmatthos', 'images/Capa nova.jpg')).toBe(
      'https://f005.backblazeb2.com/file/josephmatthos/images/Capa%20nova.jpg'
    );
  });

  it('creates a signed PUT URL without exposing credentials', async () => {
    setB2Env({
      region: 'us-east-005',
      keyId: 'key-id',
      appKey: 'application-key'
    });

    const { uploadUrl } = await storage.createSignedUploadUrl(
      'audio-preview',
      'track.mp3',
      'audio/mpeg',
      900
    );

    expect(uploadUrl).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(uploadUrl).toContain('X-Amz-Credential=key-id%2F');
    expect(uploadUrl).not.toContain('application-key');
  });

  it('continues to support the legacy B2 variable names', () => {
    vi.stubEnv('B2_MEDIA_REGION', '');
    vi.stubEnv('B2_MEDIA_ENDPOINT', '');
    vi.stubEnv('B2_MEDIA_BUCKET', '');
    vi.stubEnv('B2_IMAGE_PUBLIC_URL', '');
    vi.stubEnv('B2_REGION', 'us-east-005');
    vi.stubEnv('B2_ENDPOINT', 'https://s3.us-east-005.backblazeb2.com');
    vi.stubEnv('B2_PUBLIC_BASE_URL', 'https://f005.backblazeb2.com/file');
    vi.stubEnv('B2_KEY_ID', 'key-id');
    vi.stubEnv('B2_APPLICATION_KEY', 'application-key');
    vi.stubEnv('B2_BUCKET_SITE_ASSETS', 'site-assets');

    expect(storage.getStorageConfig()).toMatchObject({
      endpoint: 'https://s3.us-east-005.backblazeb2.com',
      publicBaseUrl: 'https://f005.backblazeb2.com/file'
    });
  });
});