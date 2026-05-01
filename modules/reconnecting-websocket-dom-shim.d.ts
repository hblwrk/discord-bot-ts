// reconnecting-websocket references the DOM BinaryType alias even when used with ws in Node.
declare global {
  type BinaryType = "arraybuffer" | "blob";
}

export {};
