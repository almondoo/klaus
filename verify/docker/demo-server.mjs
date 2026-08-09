import { createServer } from "node:http";

// klaus コンテナ(別コンテナ)から名前解決で到達できるよう 0.0.0.0 で待ち受ける。
// 127.0.0.1 のままだとコンテナ内部からしかアクセスできず、compose ネットワーク越しの
// klaus run が接続できなくなる。
createServer((req, res) => {
  if (req.url === "/login") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ token: "demo-token" }));
  } else if (req.url === "/me") {
    const ok = req.headers.authorization === "Bearer demo-token";
    res.statusCode = ok ? 200 : 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(ok ? { email: "test@example.com" } : { error: "unauthorized" }));
  } else {
    res.statusCode = 404;
    res.end();
  }
}).listen(3000, "0.0.0.0", () => console.log("demo API on :3000"));
