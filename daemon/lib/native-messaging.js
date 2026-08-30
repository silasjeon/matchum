"use strict";

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

function encode(message, maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  if (json.length > maxBytes) throw new RangeError(`native message exceeds ${maxBytes} bytes`);
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32LE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

function createDecoder({
  maxBytes = DEFAULT_MAX_INPUT_BYTES,
  onMessage,
  onInvalidJson = () => {},
}) {
  if (typeof onMessage !== "function") throw new TypeError("onMessage callback is required");
  const header = Buffer.allocUnsafe(4);
  let headerBytes = 0;
  let body = null;
  let bodyBytes = 0;

  return (chunk) => {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    let offset = 0;

    while (offset < chunk.length) {
      if (body === null) {
        const take = Math.min(4 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + take);
        headerBytes += take;
        offset += take;
        if (headerBytes < 4) return;

        const length = header.readUInt32LE(0);
        headerBytes = 0;
        if (length === 0 || length > maxBytes) {
          throw new RangeError(`invalid native frame length: ${length}`);
        }
        body = Buffer.allocUnsafe(length);
        bodyBytes = 0;
      }

      const take = Math.min(body.length - bodyBytes, chunk.length - offset);
      chunk.copy(body, bodyBytes, offset, offset + take);
      bodyBytes += take;
      offset += take;
      if (bodyBytes < body.length) return;

      const completeBody = body;
      body = null;
      bodyBytes = 0;
      let message;
      try {
        message = JSON.parse(completeBody.toString("utf8"));
      } catch (error) {
        onInvalidJson(error);
        continue;
      }
      onMessage(message);
    }
  };
}

module.exports = {
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  encode,
  createDecoder,
};
