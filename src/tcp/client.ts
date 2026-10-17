import { Buffer } from "node:buffer";
import net from "node:net";
import { encodeRequest, decodeResponses, Op, Status } from "./protocol.js";

const mode = process.argv[2] ?? "write";

// Port 5001 maps to cache-a inside Docker.
const client = net.createConnection({ host: "127.0.0.1", port: 5001 }, () => {
  console.log(`Connected to cache A — mode: ${mode}`);

  let requests;

  if (mode === "write") {
    requests = [
      encodeRequest(Op.SET, "persist:keep", "Amos"),
      encodeRequest(Op.SET, "persist:deleted", "ShouldNotReturn"),
      encodeRequest(Op.DEL, "persist:deleted"),
      encodeRequest(Op.SET, "persist:ttl", "ExpiresSoon", 60_000),
    ];
  } else if (mode === "verify") {
    requests = [
      encodeRequest(Op.GET, "persist:keep"),
      encodeRequest(Op.GET, "persist:deleted"),
      encodeRequest(Op.GET, "persist:ttl"),
    ];
  } else if (mode === "expired") {
    requests = [encodeRequest(Op.GET, "persist:ttl")];
  } else {
    console.error("Use mode: write, verify, or expired");
    client.destroy();
    return;
  }

  client.write(Buffer.concat(requests));
});

let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let received = 0;

client.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);

  const result = decodeResponses(pending);
  pending = result.remaining;

  for (const response of result.responses) {
    received++;

    const status =
      response.status === Status.OK
        ? "OK"
        : response.status === Status.NOT_FOUND
          ? "NOT_FOUND"
          : `ERROR (${response.status})`;

    console.log(
      `Response ${received}: ${status} | ${response.value.toString("utf8")}`,
    );
  }

  const expected = mode === "write" ? 4 : mode === "verify" ? 3 : 1;

  if (received === expected) {
    client.end();
  }
});

client.on("end", () => {
  console.log("Connection closed");
});

client.on("error", (error) => {
  console.error("Client error:", error.message);
});
