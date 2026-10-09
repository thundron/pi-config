#!/usr/bin/env node
// Exercise retired extension cleanup in an isolated HOME.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, readlinkSync, lstatSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = fileURLToPath(new URL("../", import.meta.url));
const home = mkdtempSync(join(tmpdir(), "pi-install-migration-"));
const extensions = join(home, ".pi/agent/extensions");
const retired = ["compaction-diet.ts", "compaction-diet.README.md", "large-context-autocompact.ts", "large-context-autocompact.README.md"];
function install() {
	const result = spawnSync("bash", [join(repo, "install.sh")], { env: { ...process.env, HOME: home }, encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	return result;
}
try {
	mkdirSync(extensions, { recursive: true });
	for (const name of retired) symlinkSync(join(repo, "agent/extensions", name), join(extensions, name));
	install();
	for (const name of retired) assert.throws(() => lstatSync(join(extensions, name)), { code: "ENOENT" });
	assert.equal(readlinkSync(join(extensions, "compaction.ts")), resolve(repo, "agent/extensions/compaction.ts"));
	assert.equal(existsSync(join(extensions, "compaction.ts")), true);

	// Real files and even dangling external symlinks belong to the user.
	const real = join(extensions, "compaction-diet.ts");
	const external = join(extensions, "large-context-autocompact.ts");
	writeFileSync(real, "// user-owned extension\n");
	symlinkSync(join(home, "other-checkout/large-context-autocompact.ts"), external);
	const second = install();
	assert.equal(readFileSync(real, "utf8"), "// user-owned extension\n");
	assert.equal(readlinkSync(external), join(home, "other-checkout/large-context-autocompact.ts"));
	assert.match(second.stderr, /disable or remove it manually/);
	console.log("installer migration: retired owned links removed; user-owned files preserved");
} finally {
	rmSync(home, { recursive: true, force: true });
}
