import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storage = require('../api/_storage.js');

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('B2 storage configuration', () => {
  it('requires B2 credentials and region', () => {
    vi.stubEnv('B2_REGION', '');
    vi.stubEnv('B2_KEY_ID', '');
    vi.stubEnv('B2_APPLICATION_KEY', '');

    expect(() => storage.getStorageConfig()).toThrow('Backblaze B2 não configurado.');
  });

  it('uses the regional B2 endpoints and configured bucket names', () => {
    vi.stubEnv('B2_REGION', 'us-east-005');
    vi.stubEnv('B2_KEY_ID', 'key-id');
    vi.stubEnv('B2_APPLICATION_KEY', 'application-key');
    vi.stubEnv('B2_BUCKET_SITE_ASSETS', 'media-images');

    expect(storage.getStorageConfig()).toMatchObject({
      endpoint: 'https://s3.us-east-005.backblazeb2.com',
      publicBaseUrl: 'https://f005.backblazeb2.com/file'
    });
    expect(storage.getBucketForKind('image')).toBe('media-images');
    expect(storage.getBucketForKind('audio-preview')).toBe('audio-preview');
    expect(storage.getBucketForKind('audio-full')).toBe('audio-premium');
  });

  it('encodes public object paths without flattening folders', () => {
    vi.stubEnv('B2_REGION', 'us-east-005');
    vi.stubEnv('B2_KEY_ID', 'key-id');
    vi.stubEnv('B2_APPLICATION_KEY', 'application-key');

    expect(storage.getPublicUrl('site-assets', 'images/Capa nova.jpg')).toBe(
      'https://f005.backblazeb2.com/file/site-assets/images/Capa%20nova.jpg'
    );
  });

  it('creates a signed PUT URL without exposing credentials', async () => {
    vi.stubEnv('B2_REGION', 'us-east-005');
    vi.stubEnv('B2_KEY_ID', 'key-id');
    vi.stubEnv('B2_APPLICATION_KEY', 'application-key');

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
});