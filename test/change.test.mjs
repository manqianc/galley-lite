// Unit test for the change-computation logic, evaluated from the REAL source of
// galley-lite.mjs (no copy-paste drift). Run: node test/change.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "galley-lite.mjs"), "utf8");
const start = src.indexOf("let changeSeq = 0;");
const end = src.indexOf("// Explicit turn queue");
if (start < 0 || end < 0) throw new Error("could not locate change-tracking block in source");
const block = src.slice(start, end);
const { computeChange, classifyFragment } = new Function(block + "\nreturn { computeChange, classifyFragment };")();

let pass = 0,
  fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    console.error(`FAIL ${msg}\n  expected ${e}\n  got      ${a}`);
  }
}

// 1. No content change → kind none
const c1 = computeChange("<p>a</p>", "<p>a</p>", []);
eq([c1.kind, c1.contentChanged], ["none", false], "no-op edit reports none");

// 2. Simple visible edit, attributed by the agent's Edit fragment
const c2 = computeChange("<h1>Old</h1>", "<h1>New Title</h1>", [{ tool: "Edit", newStrings: ["<h1>New Title</h1>"] }]);
eq([c2.kind, c2.fragments.length, c2.fragments[0].type], ["edit", 1, "visual"], "visible edit → 1 visual fragment");

// 3. <style> edit classified as style, not a changed element
const c3 = computeChange("<style>.x{color:red}</style>", "<style>.x{color:blue}</style>", [{ tool: "Edit", newStrings: [".x{color:blue}"] }]);
eq([c3.kind, c3.fragments[0].type], ["edit", "style"], "style edit → type style");

// 4. <script> edit classified as script
const c4 = computeChange("<script>var a=1</script>", "<script>var a=2</script>", [{ tool: "Edit", newStrings: ["var a=2"] }]);
eq(c4.fragments[0].type, "script", "script edit → type script");

// 5. Whole-file Write → kind write, no enumerated fragments
const c5 = computeChange("<p>a</p>", "<html><body>all new</body></html>", [{ tool: "Write", newStrings: ["<html><body>all new</body></html>"] }]);
eq([c5.kind, c5.fragments.length], ["write", 0], "Write → write, no fragments");

// 6. Content changed but no captured edit fragments (reformat) → write, not a fake count
const c6 = computeChange("<p>a</p>", "<p>  a  </p>", []);
eq(c6.kind, "write", "reformat with no fragments → write");

// 7. Duplicate identical fragments dedupe to one
const c7 = computeChange("<a>x</a><a>x</a>", "<a>Z</a><a>Z</a>", [{ tool: "MultiEdit", newStrings: ["<a>Z</a>", "<a>Z</a>"] }]);
eq(c7.fragments.length, 1, "identical fragments dedupe");

// 8. byteDelta is signed and correct
const c8 = computeChange("ab", "abcde", [{ tool: "Edit", newStrings: ["abcde"] }]);
eq(c8.byteDelta, 3, "byteDelta = +3");

// 9. classifyFragment standalone: text inside body is visual
eq(classifyFragment("<body><p>hello world</p></body>", "hello world"), "visual", "body text → visual");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
