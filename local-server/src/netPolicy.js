import { isPrivateLanIpv4 } from "./config.js";

export function remoteAddress(req) {
  return String(req?.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

/**
 * A LAN client is accepted only after the server was explicitly configured
 * for one private address and the connection is HTTPS from a private address.
 */
export function isApprovedLanClient(req, config) {
  if (!config?.lanAccessReady || !req?.socket?.encrypted) return false;
  const remote = remoteAddress(req);
  return (
    remote === "127.0.0.1" ||
    remote === "::1" ||
    remote === "localhost" ||
    isPrivateLanIpv4(remote)
  );
}
