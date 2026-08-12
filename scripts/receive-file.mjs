// One-shot receiver: accepts a POST body and writes it to the given path.
// Used to bridge a file from the local browser to the remote workspace.
import { createServer } from "node:http";
import { createWriteStream } from "node:fs";

const OUT = process.argv[2] ?? "/tmp/received.bin";
const PORT = parseInt(process.argv[3] ?? "4174", 10);

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ready");
    return;
  }
  let bytes = 0;
  const out = createWriteStream(OUT);
  req.on("data", (chunk) => {
    bytes += chunk.length;
    out.write(chunk);
  });
  req.on("end", () => {
    out.end(() => {
      console.log(`RECEIVED ${bytes} bytes -> ${OUT}`);
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(`ok ${bytes}`);
    });
  });
});

server.listen(PORT, () => console.log(`listening on ${PORT}, writing to ${OUT}`));
