/**
 * Test hermeticity helper (code-review finding 6).
 *
 * Emitting `session_start` runs the real extension startup: it reads
 * `<agentDir>/runbg.json` and sweeps the real tmpdir for stale logs honoring
 * `PI_RUNBG_LOG_TTL_DAYS`. Without pinning, `npm test` reads the developer's
 * settings and can DELETE their real session logs (with a short TTL in their
 * shell, even logs of running pi sessions), and any `PI_RUNBG_*` value in the
 * environment silently changes assertions.
 *
 * Call `useIsolatedAgentEnv()` at module scope in every suite that emits
 * `session_start`. It pins `PI_CODING_AGENT_DIR` to a fresh temp dir, scrubs
 * every `PI_RUNBG_*` variable, and restores the previous environment via
 * `after()`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

const AGENT_DIR_VAR = "PI_CODING_AGENT_DIR";
const TMPDIR_VAR = "TMPDIR";
const RUNBG_PREFIX = "PI_RUNBG_";

export interface IsolatedAgentEnv {
	/** The temp directory standing in for `~/.pi/agent`. */
	agentDir: string;
	/** The per-suite `TMPDIR` session logs are written to. */
	tmpDir: string;
	/** Path of the settings file the extension will read. */
	settingsPath: string;
	/** Set a `PI_RUNBG_*` (or any) variable for the current suite. */
	setEnv(name: string, value: string | undefined): void;
}

export function useIsolatedAgentEnv(options: { keep?: string[] } = {}): IsolatedAgentEnv {
	const agentDir = mkdtempSync(join(tmpdir(), "runbg-agent-"));
	const saved = new Map<string, string | undefined>();
	const remember = (name: string) => {
		if (!saved.has(name)) saved.set(name, process.env[name]);
	};

	remember(AGENT_DIR_VAR);
	process.env[AGENT_DIR_VAR] = agentDir;

	// Session logs and the stale-log sweep both live in os.tmpdir(), which
	// re-reads TMPDIR on every call — so pointing it at a per-suite directory
	// keeps every log this suite creates (and deletes) out of the developer's
	// real temp directory.
	const tmp = mkdtempSync(join(tmpdir(), "runbg-tmp-"));
	remember(TMPDIR_VAR);
	process.env[TMPDIR_VAR] = tmp;

	const keep = new Set(options.keep ?? []);
	for (const name of Object.keys(process.env)) {
		if (!name.startsWith(RUNBG_PREFIX) || keep.has(name)) continue;
		remember(name);
		delete process.env[name];
	}

	after(() => {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
		rmSync(tmp, { recursive: true, force: true });
	});

	return {
		agentDir,
		tmpDir: tmp,
		settingsPath: join(agentDir, "runbg.json"),
		setEnv(name, value) {
			remember(name);
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		},
	};
}
