/**
 * Next.js proxy (formerly "middleware"). Runs only for the admin console page
 * and gives every response a fresh nonce-based Content Security Policy: only
 * scripts Next.js itself emits with that nonce can run, so injected markup
 * cannot execute even if it ever reached the page.
 */
import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest): NextResponse {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const nonce = btoa(String.fromCharCode(...bytes));
  const isDev = process.env.NODE_ENV === 'development';

  const csp = [
    "default-src 'self'",
    // React needs eval only for dev-mode error overlays; production never allows it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('cache-control', 'no-store');
  return response;
}

export const config = {
  matcher: [
    {
      source: '/caas-admin/:path*',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
