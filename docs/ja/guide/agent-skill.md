# Agent Skill(Claude Code / Codex)

klaus はリポジトリ内に [Agent Skill](https://code.claude.com/docs/en/skills)(`SKILL.md`)形式のドキュメントを同梱している(`skills/klaus/SKILL.md`)。Claude Code や OpenAI Codex CLI に配置しておくと、フロー YAML の書き方・`validate` → `run` → `history` のコマンドワークフロー・exit code の意味などを、エージェントがソースコードや本サイトを読みに行かずに把握できる。

`klaus init` が生成する `AGENTS.md`(プロジェクト直下に置く要点まとめ)とは独立した仕組みで、こちらはツール側(Claude Code / Codex)のスキル検索機構に登録する形式。両方配置しても問題はない。

## 対応エージェントと配置先

`SKILL.md` は Claude Code に限らず、Agent Skills 形式に対応する主要エージェントで共通のフォーマットとして読み込める。作成・配置するファイルは `skills/klaus/SKILL.md` の1つのみで、エージェントごとに配置先ディレクトリを変えるだけで全対応できる。

| エージェント | Skills 配置先 |
|---|---|
| Claude Code | `.claude/skills/` / `~/.claude/skills/` |
| Codex | `.agents/skills/`($CWD / $REPO_ROOT / $HOME) |
| Gemini CLI | `.gemini/skills/` / `~/.gemini/skills/` |
| Cursor(2.4+) | `.cursor/skills/` / `~/.cursor/skills/` |
| Amp | `~/.config/amp/skills/`(グローバル)/ `.agents/skills/`(プロジェクト、Codex と共通) |
| opencode | `.opencode/skills/`(`.claude/skills/` と `.agents/skills/` も互換探索) |

以下では代表として Claude Code と Codex への配置手順を示す。他のエージェントも上表のディレクトリに同様に `skills/klaus/` をコピーすればよい。

## Claude Code への配置

以下のいずれかのディレクトリに `skills/klaus/` を丸ごとコピーする(ディレクトリ名・`SKILL.md` のファイル名は変更しないこと)。

- ユーザー全体: `~/.claude/skills/klaus/`
- リポジトリ単位: `<repo>/.claude/skills/klaus/`

klaus のソースからコピーする場合(npm パッケージにも `skills/` が同梱される):

```bash
# ユーザー全体に配置
mkdir -p ~/.claude/skills
cp -r node_modules/@almondoo/klaus/skills/klaus ~/.claude/skills/klaus

# リポジトリ単位に配置(チームで共有し git 管理する場合)
mkdir -p .claude/skills
cp -r node_modules/@almondoo/klaus/skills/klaus .claude/skills/klaus
```

klaus のリポジトリを直接クローンしている場合は `node_modules/@almondoo/klaus/skills/klaus` の代わりにそのチェックアウトの `skills/klaus` を指定する。

## Codex への配置

Codex CLI のスキルディレクトリは `~/.codex/skills/` **ではない**。以下のいずれかに配置する。

- ユーザー全体: `$HOME/.agents/skills/klaus/`
- リポジトリ単位: `$REPO_ROOT/.agents/skills/klaus/`

```bash
mkdir -p ~/.agents/skills
cp -r node_modules/@almondoo/klaus/skills/klaus ~/.agents/skills/klaus
```

## 配置後の確認

配置先のディレクトリ構成が以下になっていることを確認する。

```
<skills-dir>/klaus/
└── SKILL.md
```

エージェントを再起動(または新しいセッションを開始)すると、YAML frontmatter の `description` に基づいてスキルが検出され、klaus のフロー定義に関する作業時に自動的に参照されるようになる。

`klaus init` はこのスキルファイルの配置は行わない(スコープ外)。プロジェクト直下向けの要点まとめが必要な場合は `klaus init` が生成する `AGENTS.md` を使うこと。
