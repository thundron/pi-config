#!/usr/bin/env node
// Typecheck pi extensions against the installed pi-coding-agent .d.ts files.
//
// Why this exists: pi loads .ts extensions via bun's loader, which strips
// types without type-checking. That means contract violations against
// pi-coding-agent / pi-tui types reach the user as TUI crashes
// (e.g. `Cannot read properties of undefined (reading 'endsWith')` when
// `AutocompleteItem.label` is omitted). This test runs `tsc --noEmit` so
// those violations are caught before commit.
//
// Strategy:
//   1. Resolve the pi-coding-agent install (env override, or the install
//      directory the `pi` binary symlink points into).
//   2. Build a throwaway tsconfig that points at the installed .d.ts files
//      via `paths` so `import "@earendil-works/pi-coding-agent"` (and its
//      nested workspace siblings) resolve correctly.
//   3. Invoke `tsc --noEmit` and report.
//
// Skips with exit 0 if neither `tsc` nor `npx` is available, so this never
// breaks contributors who just want to run the unit tests.

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function log(msg) { process.stdout.write(`${msg}\n`); }
function warn(msg) { process.stderr.write(`${msg}\n`); }

function which(cmd) {
	const r = spawnSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8" });
	return r.status === 0 ? r.stdout.trim().split(/\r?\n/)[0] : null;
}

// ─── Locate pi-coding-agent install ────────────────────────────────────────

function locatePiCodingAgent() {
	if (process.env.PI_CODING_AGENT_DIR && existsSync(process.env.PI_CODING_AGENT_DIR)) {
		return process.env.PI_CODING_AGENT_DIR;
	}
	const piBin = which("pi");
	if (piBin) {
		try {
			const real = realpathSync(piBin);
			// real = .../lib/node_modules/@earendil-works/pi-coding-agent/dist/bin/pi.js (or similar)
			let dir = dirname(real);
			while (dir && dir !== "/" && !existsSync(join(dir, "package.json"))) dir = dirname(dir);
			if (dir && existsSync(join(dir, "package.json"))) return dir;
		} catch { /* fall through */ }
	}
	// Last resort: common Homebrew prefix
	const guess = "/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent";
	if (existsSync(guess)) return guess;
	return null;
}

const piPkgDir = locatePiCodingAgent();
if (!piPkgDir) {
	warn("test-typecheck: could not locate @earendil-works/pi-coding-agent install — skipping.");
	process.exit(0);
}

const piIndex = join(piPkgDir, "dist", "index.d.ts");
if (!existsSync(piIndex)) {
	warn(`test-typecheck: pi-coding-agent install missing ${piIndex} — skipping.`);
	process.exit(0);
}

// Each sibling workspace package (pi-ai, pi-agent-core, pi-tui) ships its own
// .d.ts inside pi-coding-agent's nested node_modules. Tell tsc where each is.
function siblingTypes(name) {
	const p = join(piPkgDir, "node_modules", "@earendil-works", name, "dist", "index.d.ts");
	return existsSync(p) ? p : null;
}
function siblingTypesAlt(name, ...rel) {
	// some packages ship index.d.mts or similar — we try a couple of fallbacks
	for (const r of rel) {
		const p = join(piPkgDir, "node_modules", name, ...r);
		if (existsSync(p)) return p;
	}
	return null;
}

const paths = {
	"@earendil-works/pi-coding-agent": [piIndex],
};
for (const sib of ["pi-ai", "pi-agent-core", "pi-tui"]) {
	const t = siblingTypes(sib);
	if (t) paths[`@earendil-works/${sib}`] = [t];
}
const typebox = siblingTypesAlt("typebox", ["build", "index.d.mts"], ["build", "index.d.ts"]);
if (typebox) paths.typebox = [typebox];

// ─── tsc runner ────────────────────────────────────────────────────────────

function findTsc() {
	// Prefer a local tsc if installed; else npx -y -p typescript@5.6.3 tsc.
	const local = which("tsc");
	if (local) return { cmd: local, args: [] };
	const npx = which("npx");
	if (npx) return { cmd: npx, args: ["-y", "-p", "typescript@5.6.3", "tsc"] };
	return null;
}

const tsc = findTsc();
if (!tsc) {
	warn("test-typecheck: neither tsc nor npx on PATH — skipping.");
	process.exit(0);
}

// ─── temp tsconfig ─────────────────────────────────────────────────────────

const work = mkdtempSync(join(tmpdir(), "pi-typecheck-"));
try {
	const tsconfig = {
		compilerOptions: {
			target: "ES2022",
			module: "ESNext",
			moduleResolution: "Bundler",
			lib: ["ES2022"],
			types: [],
			strict: true,
			noImplicitAny: false,
			noEmit: true,
			skipLibCheck: true,
			esModuleInterop: true,
			allowImportingTsExtensions: true,
			baseUrl: REPO_ROOT,
			paths,
		},
		include: [join(REPO_ROOT, "agent/extensions/*.ts")],
	};
	const cfgPath = join(work, "tsconfig.json");
	writeFileSync(cfgPath, JSON.stringify(tsconfig, null, 2));

	log(`test-typecheck: tsc -p ${cfgPath}`);
	const r = spawnSync(tsc.cmd, [...tsc.args, "-p", cfgPath], { encoding: "utf8" });
	const out = (r.stdout || "") + (r.stderr || "");

	// Filter to real diagnostics — strip TS2307 ("Cannot find module") for
	// nested @earendil-works/* deps when our paths-resolution can't find a
	// type entry; that's a test-config issue, not a code bug. We still
	// surface TS2307 for OTHER packages (typos in imports).
	const lines = out.split(/\r?\n/);
	const ignorable = (line) => {
		if (!/error TS2307/.test(line)) return false;
		// allow-list: nested workspace deps we know are present at runtime
		return /@earendil-works\/(pi-ai|pi-agent-core|pi-tui)/.test(line) || /'typebox'/.test(line);
	};
	const real = lines.filter((l) => /error TS\d+/.test(l) && !ignorable(l));
	const ignored = lines.filter((l) => /error TS\d+/.test(l) && ignorable(l));

	if (ignored.length) {
		warn(`test-typecheck: ${ignored.length} ignored module-resolution warning(s) (nested deps not found by tsc):`);
		for (const l of ignored.slice(0, 5)) warn(`  ${l}`);
	}

	if (real.length > 0) {
		warn(`test-typecheck: ${real.length} type error(s):`);
		for (const l of real) warn(`  ${l}`);
		process.exit(1);
	}

	log(`test-typecheck: OK (${ignored.length} ignored, 0 real)`);
} finally {
	try { rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
}
