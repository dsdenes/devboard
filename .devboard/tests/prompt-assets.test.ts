import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { syncHarnessTrees } from "../bin/devboard.mjs";
import { packHarness, packedPaths, stageHarness } from "../scripts/harness-package";

/**
 * A shipped prompt may only name a `.devboard/...` path the installed host
 * really has. The tracker prompts invoke `.devboard/scripts/forge-auth.ts`, so
 * the package, the staged release, and the host prefix must all carry it.
 */

const harnessRoot = resolve(import.meta.dir, "..");
const testRoot = join(harnessRoot, ".tmp");
const roots: string[] = [];

/**
 * Paths a prompt names inside the host prefix but which belong to the host:
 * goal specs, draft proposals, and optional harness instructions. The installer
 * never ships them.
 */
const HOST_OWNED = ["AGENTS.md", "goals", "goal-proposals"];

function temporaryDirectory(name: string): string {
	mkdirSync(testRoot, { recursive: true });
	const directory = join(testRoot, `${name}-${crypto.randomUUID()}`);
	mkdirSync(directory, { recursive: true });
	roots.push(directory);
	return directory;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** `.devboard/<path>` references in the shipped prompts, relative to the harness root. */
function promptReferences(): Map<string, string[]> {
	const prompts = readdirSync(join(harnessRoot, "prompts")).filter((name) => name.endsWith(".md"));
	const references = new Map<string, string[]>();
	for (const prompt of prompts) {
		const text = readFileSync(join(harnessRoot, "prompts", prompt), "utf8");
		for (const match of text.matchAll(/\.devboard\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)/g)) {
			const relative = match[1]!.replace(/\/+$/, "");
			if (relative === "") continue;
			if (HOST_OWNED.some((owned) => relative === owned || relative.startsWith(`${owned}/`))) continue;
			// Runtime scratch the host creates on demand; the package never ships it.
			if (relative === ".tmp" || relative.startsWith(".tmp/")) continue;
			// Illustrative paths such as `.devboard/client/Foo.svelte` name no harness file.
			if (!existsSync(join(harnessRoot, relative))) continue;
			const files = references.get(relative) ?? [];
			if (!files.includes(prompt)) files.push(prompt);
			references.set(relative, files);
		}
	}
	return references;
}

describe("shipped prompt assets", () => {
	test("the staged release contains every harness path a prompt names", async () => {
		const staging = join(temporaryDirectory("prompt-assets"), "package");
		await stageHarness(staging, "0.0.0-prompt-assets");
		for (const [relative, prompts] of promptReferences()) {
			expect({ path: relative, prompts, present: existsSync(join(staging, relative)) }).toEqual({
				path: relative,
				prompts,
				present: true,
			});
		}
	});

	// The npm tarball is the install authority; the staging copy above is the
	// release-artifact path. Both must carry the same files.
	test("the npm tarball contains every harness path a prompt names", async () => {
		const references = promptReferences();
		const { tarball } = await packHarness("0.0.0-prompt-assets", temporaryDirectory("prompt-pack"));
		const packed = new Set(await packedPaths(tarball));
		for (const [relative, prompts] of references) {
			expect({ path: relative, prompts, present: packed.has(relative) }).toEqual({
				path: relative,
				prompts,
				present: true,
			});
		}
		expect(packed.has("scripts/forge-auth.ts")).toBe(true);
	});

	test("install copies the forge-auth wrapper into the host prefix and it runs", async () => {
		const host = temporaryDirectory("prompt-host");
		await syncHarnessTrees(host, harnessRoot);
		const wrapper = join(host, ".devboard", "scripts", "forge-auth.ts");
		expect(readFileSync(wrapper).equals(readFileSync(join(harnessRoot, "scripts", "forge-auth.ts")))).toBe(true);

		const result = Bun.spawnSync({
			cmd: [process.execPath, wrapper, "--help"],
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("forge-auth check");
	});
});
