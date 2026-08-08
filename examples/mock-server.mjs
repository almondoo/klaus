// examples/api/auth-flow.yaml を試すためのダミー API サーバー。
//   POST /login  … body.email を token(base64)に詰めて返す
//   GET  /me     … Authorization: Bearer <token> から email を復元して返す
// login した email をそのまま返すので、環境(local/development)を切り替えても
// アサーション testEmail と整合する。
import { createServer } from "node:http";

const PORT = 3000;

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");

    if (req.url === "/login" && req.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      const email = body.email ?? "unknown";
      res.end(JSON.stringify({ token: Buffer.from(email).toString("base64") }));
      return;
    }

    if (req.url === "/me" && req.method === "GET") {
      const token = (req.headers.authorization ?? "").replace("Bearer ", "");
      let email = "unknown";
      try {
        email = Buffer.from(token, "base64").toString("utf-8");
      } catch {}
      res.end(JSON.stringify({ email }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock API on http://127.0.0.1:${PORT}`));
