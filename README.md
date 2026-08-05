# pi-runbg

> **Status: design only — nothing implemented yet.**

A pi extension for **long-lived background sessions** — the codex
`unified_exec` model ported to pi: every command becomes a session the agent
drives across turns with writes and polls, instead of a single blocking
`bash` call.

## Approach

Build on [pi-unified-exec](https://github.com/iamwrm/pi-unified-exec) (MIT,
unmaintained — we fork it). It is a faithful port of codex's `unified_exec`
with a proven tool surface and 250+ tests. Our additions: the system-prompt
integration that fixes the long-running-loop failure mode, headless-safety
review, and ongoing hardening.

See [docs/design.md](docs/design.md) for the full design.

## Layout

```
pi-runbg/
├── README.md          ← you are here
├── docs/design.md     ← full design (v2: aligned with pi-unified-exec)
└── .gitignore
```

## Related

- [pi-sysprompt](../pi-sysprompt) — template wiring for the session discipline
- [pi-webfetch](../pi-webfetch) — sibling web-tool design
