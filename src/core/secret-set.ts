/**
 * 秘密値の収集先(TemplateContext.secrets)。Set<string> として従来どおり使えるうえで、
 * 「cookie 由来の登録」を区別して覚える。
 * cookie 値(Set-Cookie の 16 文字以上の値・capture: { cookie })は、`ct=application/json` のように
 * 構造的なヘッダー値と偶然一致し得るため、カセット(cassette.ts)の構造的ヘッダーの復元判定では
 * 「cookie 由来ではない秘密値(env・認証トークンなど)」だけを使う。
 */
export class SecretSet extends Set<string> {
  /** cookie 由来としてのみ登録されている値(cookie 以外の経路でも登録された値は含まない) */
  private readonly cookieOnly = new Set<string>();

  /** cookie 由来の秘密値として登録する(既に cookie 以外の経路で登録済みの値は、そちらを優先する) */
  addCookie(value: string): this {
    if (!super.has(value)) {
      super.add(value);
      this.cookieOnly.add(value);
    }
    return this;
  }

  /** cookie 以外の経路での登録。cookie 由来として登録済みでも、非 cookie 由来に格上げする */
  override add(value: string): this {
    this.cookieOnly?.delete(value);
    return super.add(value);
  }

  override delete(value: string): boolean {
    this.cookieOnly.delete(value);
    return super.delete(value);
  }

  override clear(): void {
    this.cookieOnly.clear();
    super.clear();
  }

  /** cookie 由来のみの値を除いた秘密値の一覧 */
  nonCookieValues(): string[] {
    return [...this].filter((value) => !this.cookieOnly.has(value));
  }
}

/** sink が SecretSet なら cookie 由来として、普通の Set なら通常の秘密値として登録する */
export function addCookieSecret(sink: Set<string> | undefined, value: string): void {
  if (sink instanceof SecretSet) sink.addCookie(value);
  else sink?.add(value);
}

/** secrets から、cookie 由来のみの値を除いた一覧を返す(SecretSet でなければ全件) */
export function nonCookieSecrets(secrets: Set<string> | undefined): string[] {
  if (secrets === undefined) return [];
  return secrets instanceof SecretSet ? secrets.nonCookieValues() : [...secrets];
}
