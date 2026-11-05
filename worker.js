import { AwsClient } from 'aws4fetch';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let path = url.pathname;

    if (path.startsWith('/')) path = path.slice(1);
    if (!path) return new Response('Not found', { status: 404 });

    path = decodeURIComponent(path);

    const bucket = env.B2_BUCKET;
    const key = path;  // O path inteiro, com o prefixo "josephmatthos/"

    if (!key) return new Response('Invalid path', { status: 400 });

    const region = env.B2_REGION || 'us-east-005';

    const aws = new AwsClient({
      accessKeyId: env.B2_KEY_ID,
      secretAccessKey: env.B2_APPLICATION_KEY,
      service: 's3',
      region: region
    });

    const endpoint = env.B2_ENDPOINT.replace(/^https?:\/\//, '');
    const b2Url = `https://${bucket}.${endpoint}/${key}`;

    const headersToSign = {};
    const range = request.headers.get('range');
    if (range) headersToSign.Range = range;

    try {
      const signedRequest = await aws.sign(b2Url, {
        method: 'GET',
        headers: headersToSign
      });

      const response = await fetch(signedRequest);

      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cache-Control', 'public, max-age=86400, immutable');
      newHeaders.set('Access-Control-Allow-Origin', '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', 'Range');
      newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders
      });
    } catch (err) {
      console.error('[cdn] erro:', err.message, 'url:', b2Url);
      return new Response(`Erro ao buscar no B2: ${err.message}`, { status: 500 });
    }
  }
};