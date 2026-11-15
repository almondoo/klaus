import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";

/** テスト用の自己署名証明書(CN/SAN = 127.0.0.1)。openssl で生成し、PEM の内容とパスを返す */
export interface TestCert {
  dir: string;
  certPath: string;
  keyPath: string;
  cert: string;
  key: string;
}

/** リポジトリ直下 tmp/ に mkdtemp した場所へ openssl で使い捨ての証明書を作る(OS の /tmp は使わない) */
export async function generateTestCert(): Promise<TestCert> {
  const root = join(process.cwd(), "tmp");
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, "tls-"));
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  return {
    dir,
    certPath,
    keyPath,
    cert: await readFile(certPath, "utf-8"),
    key: await readFile(keyPath, "utf-8"),
  };
}
