/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone tracing needs symlink privileges, which Windows dev machines lack.
  // The Dockerfile sets NEXT_OUTPUT=standalone so production images still get it.
  output: process.env.NEXT_OUTPUT === 'standalone' ? 'standalone' : undefined,
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: [
    '@medicore/ui-components',
    '@medicore/i18n',
    '@medicore/shared-types',
    '@medicore/country-packs',
  ],
  // Off: clinical navigation is built from runtime ids, so hrefs are template literals.
  typedRoutes: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
