/** Headers every response gets. The admin page adds its own nonce CSP in proxy.ts. */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produces .next/standalone with a minimal server.js for the container image.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // The sanitizer pulls in htmlparser2/postcss; keep it as a plain Node dependency.
  serverExternalPackages: ['sanitize-html', 'properties-reader', 'newrelic'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
