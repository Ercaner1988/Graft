/**
 * #323 at the process boundary: a depth-tier grammar that will not load must cost
 * its own language, not the whole CLI.
 *
 * The reported machine is a Windows box with no C toolchain, where
 * `tree-sitter-kotlin` — which ships no prebuilds at all — cannot be built at
 * install time and throws from `require()`. Because extract.ts imported all nine
 * grammars at the top of the module, that killed every command, `--version` and
 * `--help` included, with a `node-gyp-build` stack trace that never says "graft".
 *
 * `break-grammar-preload.cjs` stands in for the missing build so this runs
 * anywhere — including on a runner that HAS a compiler, which is exactly why CI
 * never caught the original.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { tmpRepo } from "./helpers.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import { contextDirFor } from "../src/context/node-file.js";

const PRELOAD = fileURLToPath(new URL("./break-grammar-preload.cjs", import.meta.url));

/** graft, run with `pkg` made unloadable. Cwd is the repo root, as it is under `npm test`. */
function graft(args: string[], pkg: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--require", PRELOAD, "--import", "tsx", "src/cli.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, GRAFT_TEST_BREAK_GRAMMAR: pkg, DO_NOT_TRACK: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const KOTLIN = `package demo

class Repo(private val name: String) {
    fun describe(): String = "repo $name"
}
`;

test("#323: a grammar that will not load no longer stops the CLI from starting", () => {
  const r = graft(["--version"], "tree-sitter-kotlin");
  assert.equal(r.status, 0, `--version should survive an unloadable grammar\n${r.stderr}`);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
  // A command that parses nothing has no reason to mention the grammar at all.
  assert.doesNotMatch(r.stderr, /tree-sitter-kotlin/);
});

test("#323: the other languages still index, and the affected one says so once", () => {
  const dir = tmpRepo("grammar-unavailable");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export function greet(): string {\n  return \"hi\";\n}\n");
  // Two, so "once per language" is a claim the test can actually fail on.
  writeFileSync(join(dir, "src", "Repo.kt"), KOTLIN);
  writeFileSync(join(dir, "src", "Other.kt"), KOTLIN.replace("Repo", "Other"));

  const r = graft(["build", dir], "tree-sitter-kotlin");
  assert.equal(r.status, 0, `build should not die with one grammar down\n${r.stderr}`);
  assert.equal(
    r.stderr.match(/tree-sitter-kotlin failed to load/g)?.length,
    1,
    `warned exactly once, whatever the file count\n${r.stderr}`,
  );

  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  assert.ok(
    g!.nodes.some((n) => n.name === "greet"),
    "TypeScript is indexed as usual — one dead grammar is not nine",
  );
});

test("#323/#211: `graft mcp` answers initialize without touching any grammar", async () => {
  const dir = tmpRepo("grammar-mcp-handshake");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "app.ts"), "export function greet(): string {\n  return \"hi\";\n}\n");

  // Breaking tree-sitter-typescript is the sharpest version of this test: it is
  // the grammar every real repo has, so if the initialize path went anywhere
  // near a build (or grammar loading became eager again), this is the one most
  // likely to trip it — and its "failed to load" warning is unmistakable if it
  // ever fires.
  const child = spawn(process.execPath, ["--require", PRELOAD, "--import", "tsx", "src/cli.ts", "mcp", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GRAFT_TEST_BREAK_GRAMMAR: "tree-sitter-typescript", DO_NOT_TRACK: "1" },
  });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  child.stdin.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    }) + "\n",
  );

  const deadline = Date.now() + 15_000;
  while (!stdout.includes("\n") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  await closed.catch(() => {});

  const reply = JSON.parse(stdout.split("\n")[0] || "{}");
  assert.equal(reply.id, 1, `initialize should answer promptly, unblocked by any grammar\n${stderr}`);
  assert.ok(reply.result?.protocolVersion, `initialize result missing\n${stdout}`);
  assert.doesNotMatch(
    stderr,
    /tree-sitter-typescript failed to load/,
    "a handshake with no build must never reach grammar loading at all",
  );
});

test("#323: Kotlin falls back to the breadth tier instead of going unindexed", () => {
  const dir = tmpRepo("grammar-fallback");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "Repo.kt"), KOTLIN);

  const r = graft(["build", dir], "tree-sitter-kotlin");
  assert.equal(r.status, 0, `build should not die with one grammar down\n${r.stderr}`);

  const g = readGraph(wiringPath(contextDirFor(dir)));
  assert.ok(g, "graph built");
  const kt = g!.nodes.filter((n) => n.path.endsWith(".kt") && n.kind !== "file");
  assert.ok(kt.length > 0, "Kotlin is still indexed, at signature depth");
  assert.ok(kt.every((n) => n.origin === "generic"), `…through the breadth tier (${kt.map((n) => n.origin).join(", ")})`);
  assert.ok(kt.some((n) => n.name === "Repo"), `the class is there (got ${kt.map((n) => n.name).join(", ")})`);
});
