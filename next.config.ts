import type { NextConfig } from "next";

const ORD_BASE_RAW = process.env.NEXT_PUBLIC_ORD_BASE;
let ordExtraOrigin = '';
if (ORD_BASE_RAW) {
  try {
    const origin = new URL(ORD_BASE_RAW).origin;
    if (origin !== 'https://ordinals.com') ordExtraOrigin = ` ${origin}`;
  } catch {
    // ignore malformed NEXT_PUBLIC_ORD_BASE — runtime will surface the error
  }
}

const nextConfig: NextConfig = {
  headers: async () => [
    {
      source: '/(.*)',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        {
          key: 'Content-Security-Policy',
          value: [
            "default-src 'self'",
            // M5: unsafe-eval removed for production XSS protection. If dev mode breaks, run with NEXT_PUBLIC_CSP_DEV=1
            process.env.NEXT_PUBLIC_CSP_DEV
              ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'"
              : "script-src 'self' 'unsafe-inline'",
            // fonts.googleapis.com is required by the sats-connect wallet-picker
            // modal (renders inline in the dapp page on `wallet_connect`).
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com",
            `connect-src 'self' https://mempool.space https://*.mempool.space https://ordinals.com${ordExtraOrigin}`,
            "img-src 'self' data: blob:",
            "frame-ancestors 'none'",
          ].join('; '),
        },
      ],
    },
  ],
  turbopack: {
    root: __dirname,
  },
  webpack: (config) => {
    // WASM support
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    // Node built-in fallbacks for browser bundle
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
