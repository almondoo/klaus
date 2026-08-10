# Agent Skill (Claude Code / Codex)

klaus ships an [Agent Skill](https://code.claude.com/docs/en/skills) (`SKILL.md`) inside the repository (`skills/klaus/SKILL.md`). Placing it where Claude Code or the OpenAI Codex CLI look for skills lets the agent learn how to write flow YAML, the `validate` → `run` → `history` command workflow, and what each exit code means — without reading the source code or this site.

This is independent from the `AGENTS.md` that `klaus init` generates (a project-root summary file); this one is registered with the tool's own skill-discovery mechanism. It's fine to have both.

## Supported agents and install locations

`SKILL.md` isn't Claude Code-specific — it's a common format that major agents supporting Agent Skills can all read. You only need to create and place one file, `skills/klaus/SKILL.md`; the only thing that differs per agent is the install directory.

| Agent | Skills install location |
|---|---|
| Claude Code | `.claude/skills/` / `~/.claude/skills/` |
| Codex | `.agents/skills/` ($CWD / $REPO_ROOT / $HOME) |
| Gemini CLI | `.gemini/skills/` / `~/.gemini/skills/` |
| Cursor (2.4+) | `.cursor/skills/` / `~/.cursor/skills/` |
| Amp | `~/.config/amp/skills/` (global) / `.agents/skills/` (project, shared with Codex) |
| opencode | `.opencode/skills/` (also compat-searches `.claude/skills/` and `.agents/skills/`) |

The sections below walk through installing for Claude Code and Codex as representative examples. For any other agent, copy `skills/klaus/` into the directory listed above.

## Installing for Claude Code

Copy the whole `skills/klaus/` directory into one of the following (keep the directory name and the `SKILL.md` filename unchanged):

- User-wide: `~/.claude/skills/klaus/`
- Per-repository: `<repo>/.claude/skills/klaus/`

When copying from the klaus source (the `skills/` directory also ships in the npm package):

```bash
# Install user-wide
mkdir -p ~/.claude/skills
cp -r node_modules/@almondoo/klaus/skills/klaus ~/.claude/skills/klaus

# Install per-repository (to share with the team and check into git)
mkdir -p .claude/skills
cp -r node_modules/@almondoo/klaus/skills/klaus .claude/skills/klaus
```

If you have a direct checkout of the klaus repository, use that checkout's `skills/klaus` instead of `node_modules/@almondoo/klaus/skills/klaus`.

## Installing for Codex

The Codex CLI skills directory is **not** `~/.codex/skills/`. Install into one of the following instead.

- User-wide: `$HOME/.agents/skills/klaus/`
- Per-repository: `$REPO_ROOT/.agents/skills/klaus/`

```bash
mkdir -p ~/.agents/skills
cp -r node_modules/@almondoo/klaus/skills/klaus ~/.agents/skills/klaus
```

## Verifying the installation

Confirm the installed directory looks like this:

```
<skills-dir>/klaus/
└── SKILL.md
```

Restart the agent (or start a new session), and the skill will be discovered based on the `description` in the YAML frontmatter, then automatically referenced when the agent works on klaus flow definitions.

`klaus init` does not install this skill file (out of scope). If you need a project-root summary instead, use the `AGENTS.md` that `klaus init` generates.
