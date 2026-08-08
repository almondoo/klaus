import { Gear } from "@phosphor-icons/react";
import "./AuthGuard.css";

/** token が無い/401 の場合に表示する案内画面 */
export function AuthGuard() {
  return (
    <div className="klaus-auth-guard">
      <div className="klaus-auth-guard__icon">
        <Gear size={40} weight="regular" />
      </div>
      <h1>klaus UI に接続できません</h1>
      <p>認証トークンが見つからないか、無効になっています。</p>
      <p>
        CLI から <code>klaus ui</code> を実行して起動し、表示された URL を開いてください。
      </p>
    </div>
  );
}
