// A node address as FDM holds it is a socket address — a host and a port — not an IP.
// The distinction matters because the two forms punctuate differently: IPv4 is bare
// (`1.2.3.4:16127`) and IPv6 is bracketed (`[2001:db8::1]:9130`), so the port cannot be
// found by splitting on the first colon. Doing that to an IPv6 address yields `[2001`,
// which is a valid-looking string that is wrong in every way that matters.

/**
 * Split a socket address into its host and port.
 *
 * The host keeps its brackets for IPv6, because that is the form haproxy and URLs need
 * when a port follows it.
 *
 * @param {string} socketAddress
 * @returns {{host: string, port: string|null}}
 */
function parseSocketAddress(socketAddress) {
  const split = socketAddress.startsWith('[')
    ? socketAddress.indexOf(']') + 1
    : socketAddress.indexOf(':');
  if (split < 1) return { host: socketAddress, port: null };
  const host = socketAddress.slice(0, split);
  const rest = socketAddress.slice(split);
  return { host, port: rest.startsWith(':') ? rest.slice(1) : null };
}

/**
 * The host with any IPv6 brackets removed — the form used where a bare address is wanted,
 * such as an haproxy server name.
 *
 * @param {string} host
 * @returns {string}
 */
function unbracket(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

module.exports = { parseSocketAddress, unbracket };
