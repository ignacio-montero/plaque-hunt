/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone output: Next traces exactly the files the server needs into
  // .next/standalone, so the production Docker image ships a tiny self-contained
  // server (node server.js) instead of the whole node_modules tree. Keeps the
  // image small for the low-power homelab box. See Dockerfile.
  output: "standalone",
  // Open Plaques photos are hosted on Flickr; allow remote thumbnails if we ever render them.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.staticflickr.com" },
      { protocol: "https", hostname: "openplaques.org" },
    ],
  },
  // tesseract.js + sharp run server-side in the /api/capture route (Node
  // runtime). Both load native/wasm assets from disk — keep them external so
  // the bundler never tries to inline them (the Dockerfile copies the full
  // packages into the runtime image).
  serverExternalPackages: ["tesseract.js", "sharp"],
};

export default nextConfig;
