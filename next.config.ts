import type { NextConfig } from "next";

// Collect every configured ord origin (mainnet + testnet + legacy single value),
// dedupe, drop the public default, and append the remainder to connect-src.
// This way per-network ord overrides (e.g. local testnet ord while mainnet stays
// on ordinals.com) both pass CSP without anyone having to edit this file.
function buildOrdExtraOrigins(): string {
  const candidates = [
    process.env.NEXT_PUBLIC_ORD_BASE_MAINNET,
    process.env.NEXT_PUBLIC_ORD_BASE_TESTNET,
    process.env.NEXT_PUBLIC_ORD_BASE,
  ];
  const origins = new Set<string>();
  for (const raw of candidates) {
    if (!raw) continue;
    try {
      const origin = new URL(raw).origin;
      if (origin !== 'https://ordinals.com') origins.add(origin);
    } catch {
      // ignore malformed value — runtime will surface the error
    }
  }
  return origins.size > 0 ? ' ' + [...origins].join(' ') : '';
}

const ordExtraOrigin = buildOrdExtraOrigins();

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
            `connect-src 'self' https://mempool.space https://*.mempool.space https://mempool.emzy.de https://ordinals.com${ordExtraOrigin}`,
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
