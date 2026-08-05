# pi-runbg

> **Status: design only — nothing implemented yet.**

A pi extension idea for running long-lived processes in the background, outside
the agent turn: start a job, get a job id back immediately, poll its status and
logs later — same turn, or in a completely different session.

Pi's `bash` tool is synchronous: it blocks until the command exits. Builds,
test suites, daemons, and migrations either hog the turn or die with it.
`pi-runbg` gives the agent the "start, do other work, collect results" pattern
the codex CLI's prompt philosophy assumes.

## Why a new one?

The community attempt ([iamwrm/pi-unified-exec](https://github.com/iamwrm/pi-unified-exec))
is unmaintained and caused problems in the past. Pi itself ships no background
capability (built-in tools: `read`, `bash`, `edit`, `edit-diff`, `find`, `grep`,
`index`, `ls`, `write` — nothing async).

## Layout

```
pi-runbg/
├── README.md          ← you are here
├── docs/design.md     ← the full design: tools, state model, safety, open questions
└── .gitignore
```

Design decisions, tradeoffs, and open questions live in
[docs/design.md](docs/design.md). Implementation is intentionally out of scope
until the design is agreed.
