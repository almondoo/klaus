import { KeyRound } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** token が無い/401 の場合に表示する案内画面 */
export function AuthGuard() {
  return (
    <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background p-8 text-center">
      <Card className="max-w-md">
        <CardHeader className="items-center text-center">
          <KeyRound className="size-10 text-muted-foreground" aria-hidden="true" />
          <CardTitle className="text-xl">klaus UI に接続できません</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>認証トークンが見つからないか、無効になっています。</p>
          <p>
            CLI から{" "}
            <code className="rounded-sm bg-secondary px-1.5 py-0.5 font-mono text-foreground">
              klaus ui
            </code>{" "}
            を実行して起動し、表示された URL を開いてください。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
