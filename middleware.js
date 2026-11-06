import { NextResponse } from 'next/server';

export function middleware(request) {
  const response = NextResponse.next();
  
  // Cole a sua string CSP gigante aqui dentro
  const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://vercel.live https://pagead2.googlesyndication.com https://*.adtrafficquality.google https://*.googlesyndication.com https://*.google.com https://*.doubleclick.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com; font-src 'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com; img-src 'self' data: blob: https://*.backblazeb2.com https://*.supabase.co https://*.supabase.in https://cdn.josephmatthos.com.br https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.gstatic.com https://*.adtrafficquality.google; media-src 'self' blob: https://*.backblazeb2.com https://*.supabase.co https://*.supabase.in https://josephmatthos.onrender.com https://josephmatthos-cdn.emerson-mattos00.workers.dev https://cdn.josephmatthos.com.br; connect-src 'self' https://*.backblazeb2.com https://*.supabase.co https://*.supabase.in https://api.mercadopago.com https://pagead2.googlesyndication.com https://*.googlesyndication.com https://*.doubleclick.net https://*.google.com https://*.adtrafficquality.google https://fonts.googleapis.com https://fonts.gstatic.com https://vercel.live https://josephmatthos.onrender.com https://josephmatthos-cdn.emerson-mattos00.workers.dev https://cdn.josephmatthos.com.br; frame-src https://*.mercadopago.com https://*.mercadolibre.com https://googleads.g.doubleclick.net https://*.googlesyndication.com https://*.google.com https://*.adtrafficquality.google; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests";
  
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: '/(.*)',
};