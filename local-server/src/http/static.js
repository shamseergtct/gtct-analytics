import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(__dirname, "../../public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

/**
 * Safely resolve a public asset path. Returns null if outside PUBLIC_DIR.
 */
export function resolvePublicFile(urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  if (rel.includes("\0")) return null;
  // strip query already handled by caller
  rel = decodeURIComponent(rel);
  if (rel.includes("..")) return null;

  const candidate = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!candidate.startsWith(PUBLIC_DIR + path.sep) && candidate !== PUBLIC_DIR) {
    return null;
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return null;
  }
  return candidate;
}

export function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function tryServeStatic(req, res, urlPath) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  // API and health never served as static
  if (urlPath.startsWith("/v1/") || urlPath === "/health") return false;

  const filePath = resolvePublicFile(urlPath);
  if (!filePath) return false;

  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
  } else {
    res.end(body);
  }
  return true;
}
