/** @type {import('next').NextConfig} */
const nextConfig = {
  // Open Plaques photos are hosted on Flickr; allow remote thumbnails if we ever render them.
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.staticflickr.com" },
      { protocol: "https", hostname: "openplaques.org" },
    ],
  },
  // tesseract.js runs server-side in the /api/capture route (Node runtime).
  serverExternalPackages: ["tesseract.js"],
};

export default nextConfig;
