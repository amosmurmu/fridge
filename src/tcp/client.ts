import { Buffer } from "node:buffer";
import net from "node:net";
import {
  encodeRequest,
  decodeResponses,
  encodeMgetRequest,
  Op,
} from "./protocol.js";

const client = net.createConnection({ host: "127.0.0.1", port: 5000 }, () => {
  console.log("Connected to cache!");

  // Send two requests without waiting for the first response.
  // This is pipelining.
  // const setRequest = encodeRequest(Op.SET, "user:1", "Amos");
  //
  const requests = [
    encodeRequest(Op.SET, "user:1", "Amos"),
    encodeRequest(Op.SET, "user:2", "Mira"),

    encodeMgetRequest(["user:1", "missing", "user:2"]),

    encodeRequest(Op.SET, "temp", "gone", 1500),

    encodeRequest(Op.GET, "temp"),
  ];

  client.write(Buffer.concat(requests));

  // const getRequest = encodeRequest(Op.GET, "user:1");
  // const getRequest2 = encodeRequest(Op.GET, "user:2");
  //
  // client.write(Buffer.concat([setRequest, getRequest, getRequest2]));
  // const delRequest = encodeRequest(Op.DEL, "user:1");
  // const getAfterDelete = encodeRequest(Op.GET, "user:1");
  //
  // client.write(Buffer.concat([delRequest, getAfterDelete]));
});

// Responses can also arrive split or combined, so buffer them too.
let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);
let receivedResponses = 0;

client.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);

  const result = decodeResponses(pending);
  pending = result.remaining;

  for (const response of result.responses) {
    receivedResponses++;

    console.log("Response status:", response.status);
    console.log("Response value:", response.value.toString("utf8"));
  }

  // We sent exactly two requests, so close after two responses.
  if (receivedResponses === 5) {
    setTimeout(() => {
      client.write(encodeRequest(Op.GET, "temp"));
    }, 1800);
    // client.end();
  }

  if (receivedResponses === 6) {
    client.end();
  }
});

client.on("end", () => {
  console.log("Connection closed");
});

client.on("error", (error) => {
  console.error("Client error:", error.message);
});
