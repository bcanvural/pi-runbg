# pi-runbg

> **Status: design only — nothing implemented yet.**

A pi extension for **long-lived background sessions** — the codex
`unified_exec` model ported to pi: every command becomes a session the agent
drives across turns with writes and polls, instead of a single blocking
`bash` call.

## Approach

Fork [pi-unified-exec](https://github.com/iamwrm/pi-unified-exec) (MIT,
actively developed but closed to external contributions — forks invited). It
is a faithful port of codex's `unified_exec` with a proven tool surface and
271 passing tests. Our additions: the system-prompt integration that fixes
the long-running-loop failure mode, a flipped built-in-`bash` default (keep
it), headless verification, and hardening from upstream's own backlog.

See [docs/design.md](docs/design.md) for the full design.

## Layout

```
pi-runbg/
├── README.md          ← you are here
├── docs/design.md     ← full design (v3: verified against upstream v0.9.0 + pi 0.83)
└── .gitignore
```

## Related

- [pi-sysprompt](../pi-sysprompt) — template wiring for the session discipline
- [pi-webfetch](../pi-webfetch) — sibling web-tool design
