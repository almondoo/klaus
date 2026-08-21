// examples/ 配下のサンプル(api/*.yaml, flows/*.yaml)を試すためのダミー API サーバー。
//   POST   /login       … body.email を token(base64)に詰めて返す
//   GET    /me          … Authorization: Bearer <token> から email を復元して返す
//   GET    /users       … in-memory のユーザー一覧を返す(?limit= で件数を絞れる)
//   GET    /users/:id   … 指定 id のユーザーを返す(存在しなければ 404)
//   POST   /users       … body を in-memory に追加して 201 で返す
//   DELETE /users/:id   … 指定 id のユーザーを削除して 204 を返す(存在しなければ 404)
//   POST   /graphql     … { query, variables } を受け取り、query の内容に応じたダミーデータを返す
//   GET    /events      … Server-Sent Events で3件のイベントを短い間隔で送って終了する
//   /ws                 … WebSocket のエコーサーバー(受け取ったメッセージをそのまま送り返す)
//
// login した email をそのまま返すので、環境(local/development)を切り替えても
// アサーション testEmail と整合する。
import { createServer } from "node:http";
// ws はリポジトリ root の devDependencies(テストフィクスチャ用)。examples 独自の依存追加はしていない。
// リポジトリ root で pnpm install 済みであれば examples/ からもそのまま解決できる。
import { WebSocketServer } from "ws";

// HOST / PORT は環境変数で上書き可能(既定値はこれまでと完全に同一)。
// Docker コンテナ内から他コンテナへ公開したい場合などに HOST=0.0.0.0 で起動できるようにする。
const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3000);

// GET /users, GET/POST/DELETE /users/:id が共有する in-memory ストア。
let users = [
  { id: "1", name: "Alice", email: "alice@example.com" },
  { id: "2", name: "Bob", email: "bob@example.com" },
  { id: "3", name: "Carol", email: "carol@example.com" },
];
let nextUserId = 4;

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    // req.url はクエリ文字列込みなので URL でパースする(host はダミーでよい)。
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    res.setHeader("content-type", "application/json");

    if (url.pathname === "/login" && req.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      const email = body.email ?? "unknown";
      res.end(JSON.stringify({ token: Buffer.from(email).toString("base64") }));
      return;
    }

    if (url.pathname === "/me" && req.method === "GET") {
      const token = (req.headers.authorization ?? "").replace("Bearer ", "");
      let email = "unknown";
      try {
        email = Buffer.from(token, "base64").toString("utf-8");
      } catch {}
      res.end(JSON.stringify({ email }));
      return;
    }

    if (url.pathname === "/users" && req.method === "GET") {
      const limit = url.searchParams.get("limit");
      const list = limit ? users.slice(0, Number(limit)) : users;
      res.end(JSON.stringify({ users: list }));
      return;
    }

    if (url.pathname === "/users" && req.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      const user = {
        id: String(nextUserId),
        name: body.name ?? "unknown",
        email: body.email ?? "unknown",
      };
      nextUserId += 1;
      users.push(user);
      res.statusCode = 201;
      res.end(JSON.stringify(user));
      return;
    }

    const userIdMatch = url.pathname.match(/^\/users\/([^/]+)$/);

    if (userIdMatch && req.method === "GET") {
      const user = users.find((u) => u.id === userIdMatch[1]);
      if (!user) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.end(JSON.stringify(user));
      return;
    }

    if (userIdMatch && req.method === "DELETE") {
      const before = users.length;
      users = users.filter((u) => u.id !== userIdMatch[1]);
      if (users.length === before) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }

    if (url.pathname === "/graphql" && req.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
      const query = body.query ?? "";
      const variables = body.variables ?? {};
      // 簡易実装: query に "user" を含む場合だけ data.user を返す(それ以外は空の data)。
      if (query.includes("user")) {
        res.end(
          JSON.stringify({
            data: { user: { email: variables.email ?? "unknown", name: "Alice" } },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ data: {} }));
      return;
    }

    if (url.pathname === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      let seq = 1;
      const timer = setInterval(() => {
        if (seq > 3) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(`id: ${seq}\nevent: tick\ndata: ${JSON.stringify({ seq })}\n\n`);
        seq += 1;
      }, 50);
      // クライアント切断時に送信を止める。req の "close" はボディなし GET だと
      // 受信完了直後(送信前)に発火してしまうため、res 側の "close" を使う
      res.on("close", () => clearInterval(timer));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
});

// WebSocket は node:http サーバーの "upgrade" イベントと共存させる。
// WebSocketServer({ noServer: true }) は自前で listen しないモードで、
// upgrade イベントを横取りしてハンドシェイクするときに使う。
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (socket) => {
  // 受け取ったメッセージをそのまま送り返すだけのエコーサーバー。
  socket.on("message", (data) => {
    socket.send(data.toString());
  });
});

server.on("upgrade", (req, socket, head) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

server.listen(PORT, HOST, () => console.log(`mock API on http://${HOST}:${PORT}`));
