--[[

  This script is a Lua file for decoding the Minecraft handshake (protocol
  version, hostname, next-state) with HAProxy to choose which backend to use.

  https://gist.github.com/nathan818fr/a078e92604784ad56e84843ebf99e2e5

--

  MIT LICENSE

  Copyright 2021 Nathan Poirier

  Permission is hereby granted, free of charge, to any person obtaining a copy
  of this software and associated documentation files (the "Software"), to deal
  in the Software without restriction, including without limitation the rights
  to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
  copies of the Software, and to permit persons to whom the Software is
  furnished to do so, subject to the following conditions:

  The above copyright notice and this permission notice shall be included in all
  copies or substantial portions of the Software.

  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
  SOFTWARE.

]]

local string_len = string.len
local string_byte = string.byte
local string_sub = string.sub
local string_find = string.find

--- Returns the number of readable bytes in this payload.
-- @param payload The payload
-- @return the number of readable bytes
local function payload_readable_len(payload)
    return string_len(payload[1]) - payload[2] + 1
end

--- Gets a VarInt at the current reader_index and increases the reader_index by it's length in this payload.
-- @param payload The payload
-- @param max_bytes The maximum number of bytes allowed to encode this VarInt
-- @param nilable Whether or not to return nil instead of -1 if we reach the end of the payload
-- @return the number; or -1 on error
local function payload_read_varint(payload, max_bytes, nilable)
    local ret = 0
    local bytes = 0
    local b
    while (true) do
        -- read byte
        b = string_byte(payload[1], payload[2] + bytes)
        if (b == nil) then
            if (nilable) then
                -- skip (missing data)
                return
            else
                -- fail (missing data)
                return -1
            end
        end

        -- compute result
        ret = ret | ((b & 127) << (bytes * 7))
        bytes = bytes + 1

        -- returns when the end is reached
        if (b < 128) then
            payload[2] = payload[2] + bytes
            return ret
        end

        -- fail on max length
        if (bytes >= max_bytes) then
            payload[2] = payload[2] + bytes
            return -1
        end
    end
end

--- Gets a String at the current reader_index and increases the reader_index by it's length in this payload.
-- @param payload The payload
-- @param max_prefix_bytes The maximum number of bytes allowed to encode this string prefix
-- @param max_prefix_bytes The maximum length of this string (in utf8 bytes)
-- @return the string; or false on error
local function payload_read_string(payload, max_prefix_bytes, max_utf8_len)
    local str_len = payload_read_varint(payload, max_prefix_bytes, false)
    if (str_len == -1 or str_len > max_utf8_len or str_len > payload_readable_len(payload)) then
        -- fast-fail (illegal str_len / missing data)
        return false
    end
    local str = string_sub(payload[1], payload[2], payload[2] + str_len)
    payload[2] = payload[2] + str_len
    return str
end

--- Decode the minecraft handshake packet.
-- @param payload The payload
-- @return a boolean indicating whether the packet was successfully read; or nil if we have to wait for more data
-- @return (on success) the protocol version number
-- @return (on success) the hostname string
-- @return (on success) the state number
local function read_mc_handshake(payload)
    if (payload[1] == nil) then
        -- skip (missing data)
        return
    end

    -- read packet len
    local packet_len = payload_read_varint(payload, 2, true)
    if (packet_len == nil) then
        -- skip (missing data)
        return
    end
    -- note: (packet_len)2 + (packet_id)1 + (protocol_version)4 + (hostname)2+255 + (port)2 + (state)1 = 267
    if (packet_len == -1 or packet_len > 267) then
        -- fast-fail (too long handshake packet)
        return false
    end
    if (packet_len > payload_readable_len(payload)) then
        -- skip (missing data)
        return
    end

    -- read packet id
    local packet_id = payload_read_varint(payload, 1, false)
    if (packet_id ~= 0) then
        -- fast-fail (not an handshake)
        return false
    end

    -- read protocol version
    local protocol_version = payload_read_varint(payload, 4, false)
    if (protocol_version <= 0) then
        -- fast-fail (illegal version)
        return false
    end

    -- read hostname
    -- note: we limit it to 255 utf8 bytes, considering that it contains only ascii characters
    local hostname = payload_read_string(payload, 2, 255)
    if (hostname == false) then
        -- fast-fail (illegal hostname)
        return false
    end

    -- skip port
    payload[2] = payload[2] + 2

    -- read (next_)state
    local state = payload_read_varint(payload, 1, false)
    if (state ~= 1 and state ~= 2) then
        -- fast-fail (illegal state)
        return false
    end

    -- trim clients/mods suffix from host (everything after \0) then returns
    local host_end = string_find(hostname, '\0', 1, 1)
    if (host_end ~= nil) then
        hostname = string_sub(hostname, 1, host_end - 1)
    end
    return true, protocol_version, hostname, state
end

--- HAProxy action 'lua.mc_handshake' for 'tcp-request content'.
-- Decode the minecraft handshake packet and define variables:
-- * txn.mc_proto - The minecraft protocol version number; or 0 on error
-- * txn.mc_host  - The target hostname string; or empty on error
-- * txn.mc_state - The target state number; or 0 on error
local function mc_handshake(txn)
    local res, proto, host, state = read_mc_handshake({ txn.req:data(), 1 })
    if (res == nil) then
        -- skip (missing data)
    elseif (res == false) then
        -- failed
        txn:set_var('txn.mc_proto', 0)
        txn:set_var('txn.mc_host', '')
        txn:set_var('txn.mc_state', 0)
    else
        -- succeed
        txn:set_var('txn.mc_proto', proto)
        txn:set_var('txn.mc_host', host)
        txn:set_var('txn.mc_state', state)
    end
end
core.register_action('mc_handshake', { 'tcp-req' }, mc_handshake, 0)