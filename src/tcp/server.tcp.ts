import net from "node:net";
import { CacheService } from "../services/cache.services.js";
import {
  decodeMgetKeys,
  decodeRequests,
  encodeResponse,
  Op,
  Status,
} from "./protocol.js";

const cache = new CacheService(1000);

const server = net.createServer((socket) => {
  console.log("Client connected");

  let pending: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  socket.on("data", (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);

    try {
      const result = decodeRequests(pending);

      pending = result.remaining;

      for (const request of result.requests) {
        const key = request.key.toString("utf8");
        const value = request.value.toString("utf8");

        switch (request.op) {
          case Op.GET: {
            const result = cache.get(key);

            if (result === null) {
              socket.write(encodeResponse(Status.NOT_FOUND));
            } else {
              socket.write(encodeResponse(Status.OK, String(result)));
            }
            break;
          }

          case Op.SET: {
            cache.set(
              key,
              value,
              request.ttlMs === 0 ? undefined : request.ttlMs,
            );

            socket.write(encodeResponse(Status.OK));
            break;
          }

          case Op.DEL: {
            const deleted = cache.del(key);

            socket.write(
              encodeResponse(deleted ? Status.OK : Status.NOT_FOUND),
            );
            break;
          }

          case Op.MGET: {
            const keys = decodeMgetKeys(request.key);
            const values = cache.mget(keys);

            socket.write(encodeResponse(Status.OK, JSON.stringify(values)));

            // socket.write(encodeResponse(Status.ERROR, "MGET not implemented"));
            break;
          }

          default: {
            socket.write(encodeResponse(Status.ERROR, "Unknown operation"));
          }
        }
      }
    } catch (error) {
      console.error("Invalid request:", error);
      socket.destroy();
    }
  });

  socket.on("end", () => {
    console.log("Client disconnected");
  });

  socket.on("error", (error) => {
    console.error("Socket error:", error.message);
  });
});

server.listen(5000, "127.0.0.1", () => {
  console.log("TCP cache server listening on port 5000");
});
