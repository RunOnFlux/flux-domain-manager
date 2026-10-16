// A node address as FDM holds it is a socket address — a host and a port — not an IP.
// The distinction matters because the two forms punctuate differently: IPv4 is bare
// (`1.2.3.4:16127`) and IPv6 is bracketed (`[2001:db8::1]:9130`), so the port cannot be
// found by splitting on the first colon. Doing that to an IPv6 address yields `[2001`,
// which is a valid-looking string that is wrong in every way that matters.

/**
 * Split a socket address into its host and port.
 *
 * The host is returned bracketed whenever it is IPv6, including when it arrived bare, so
 * that `${host}:${port}` is valid everywhere it is used — a URL or an haproxy server line
 * with an unbracketed IPv6 host is not.
 *
 * An address with more than one colon and no brackets is a bare IPv6 address and carries
 * no port, since expressing a port would have required the brackets.
 *
 * @param {string} socketAddress
 * @returns {{host: string, port: string|null}}
 */
function parseSocketAddress(socketAddress) {
  const at = (host, port) => ({ host, port: port || null });

  if (socketAddress.startsWith('[')) {
    const close = socketAddress.indexOf(']');
    if (close < 0) return at(socketAddress, null);
    const rest = socketAddress.slice(close + 1);
    return at(socketAddress.slice(0, close + 1), rest.startsWith(':') ? rest.slice(1) : null);
  }

  const colons = (socketAddress.match(/:/g) || []).length;
  if (colons > 1) return at(`[${socketAddress}]`, null);
  if (colons === 0) return at(socketAddress, null);
  const [host, port] = socketAddress.split(':');
  return at(host, port);
}

/**
 * Is this a bare IPv6 address — unbracketed, and therefore portless?
 *
 * @param {string} socketAddress
 * @returns {boolean}
 */
function isBareIPv6(socketAddress) {
  return !socketAddress.startsWith('[') && (socketAddress.match(/:/g) || []).length > 1;
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

module.exports = { parseSocketAddress, unbracket, isBareIPv6 };
