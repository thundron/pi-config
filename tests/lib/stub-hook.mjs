// Module resolver hook that stubs out pi's nested workspace packages.
//
// Background: pi extensions import from @earendil-works/pi-coding-agent and
// its workspace siblings (pi-ai, pi-agent-core, pi-tui), plus typebox. Those
// packages live in pi-coding-agent's NESTED node_modules, which stand-alone
// node does not resolve from this repo.
//
// NOTE: ESM named exports are static, so every value symbol an extension
// imports must appear in STUB_SOURCE below or the import throws
// "does not provide an export named 'x'". Keep it in sync with:
//   grep -h '^import {' agent/extensions/*.ts
//
// For tests that only exercise our extension code (not the real pi runtime)
// we don't need real implementations — only stubs that satisfy the imports.
// This hook intercepts those specifiers and serves a Proxy-backed stub module
// that returns harmless dummies for any property access.
//
// Activation:
//   node --import ./tests/lib/stub-hook-register.mjs <test>.mjs
// or:
//   node --import "data:text/javascript,import{registerHooks,register}from'node:module';..." <test>

import { pathToFileURL } from "node:url";

const STUB_PACKAGES = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"typebox",
];

function isStubbed(spec) {
	for (const p of STUB_PACKAGES) {
		if (spec === p || spec.startsWith(`${p}/`)) return true;
	}
	return false;
}

const STUB_SOURCE = [
	"const makeStub = () => new Proxy(function(){}, {",
	"  get(t, k) {",
	"    if (k === Symbol.toPrimitive) return () => 'stub';",
	"    if (k === 'then') return undefined;",
	"    if (k === '__esModule') return true;",
	"    return makeStub();",
	"  },",
	"  apply() { return makeStub(); },",
	"  construct() { return makeStub(); },",
	"});",
	"const stub = makeStub();",
	"export default stub;",
	// Mirrors pi's own chars/4 heuristic so token-budget math stays meaningful
	// in unit tests (a constant 0 makes every budget assertion vacuous).
	"export const estimateTokens = (m) => {",
	"  const c = m && m.content;",
	"  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('') : '';",
	"  return Math.ceil(text.length / 4);",
	"};",
	// compaction-diet: bounded summarization helpers.
	"export const generateSummary = async () => 'stub summary';",
	"export const serializeConversation = () => '';",
	"export const convertToLlm = (messages) => messages;",
	// Real impl: returns true iff event.toolName === toolName. Mirror that so
	// extensions that key behaviour on isToolCallEventType (e.g. guardian.ts's
	// bash gate) still work under the stub.
	"export const isToolCallEventType = (name, event) => Boolean(event && event.toolName === name);",
	"export const StringEnum = (vals) => ({ type: 'string', enum: vals });",
	"export const Type = stub;",
	"export const AgentMessage = stub;",
	"export const ExtensionAPI = stub;",
	"export const ExtensionCommandContext = stub;",
	"export const ExtensionContext = stub;",
].join("\n");

// Async variant (for module.register)
export function resolve(specifier, context, next) {
	if (isStubbed(specifier)) {
		return { url: `pi-stub:${specifier}`, shortCircuit: true, format: "module" };
	}
	return next(specifier, context);
}

export function load(url, context, next) {
	if (url.startsWith("pi-stub:")) {
		return { format: "module", source: STUB_SOURCE, shortCircuit: true };
	}
	return next(url, context);
}

// Sync variants (for module.registerHooks — node 22.13+)
export function resolveSync(specifier, context, next) {
	if (isStubbed(specifier)) {
		return { url: `pi-stub:${specifier}`, shortCircuit: true, format: "module" };
	}
	return next(specifier, context);
}

export function loadSync(url, context, next) {
	if (url.startsWith("pi-stub:")) {
		return { format: "module", source: STUB_SOURCE, shortCircuit: true };
	}
	return next(url, context);
}
