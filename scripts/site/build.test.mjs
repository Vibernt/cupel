import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSite } from "./build.mjs";
import { LinkResolver, validateAnchors } from "./links.mjs";
import { renderMarkdown } from "./markdown.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("renders GFM tables, nested lists, and fenced code", () => {
  const markdown = [
    "| Left | Right |",
    "| :--- | ---: |",
    "| value | `a\\|b` |",
    "",
    "- parent",
    "  - child",
    "    1. grandchild",
    "",
    "````js",
    "const example = `three ``` ticks`;",
    "````",
  ].join("\n");
  const { html } = renderMarkdown(markdown);
  assert.match(html, /<th class="align-left">Left<\/th>/);
  assert.match(html, /<th class="align-right">Right<\/th>/);
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /<ul><li>parent\s*<ul><li>child\s*<ol><li>grandchild<\/li><\/ol><\/li><\/ul><\/li><\/ul>/);
  assert.match(html, /<pre><code class="language-js">[\s\S]*three ``` ticks[\s\S]*<\/code><\/pre>/);
});

test("passes through HTML blocks and escapes Markdown text", () => {
  const markdown = [
    "<picture>",
    "  <img src=\"image.png\" alt=\"Example\">",
    "</picture>",
    "",
    "Text with <unsafe> & a preserved &copy; entity.",
  ].join("\n");
  const { html } = renderMarkdown(markdown);
  assert.match(html, /<picture>\n  <img src="image\.png" alt="Example">\n<\/picture>/);
  assert.match(html, /Text with &lt;unsafe&gt; &amp; a preserved &copy; entity\./);
});

test("renders inline and reference-style links and images", () => {
  const markdown = [
    "[Inline](guide.md#part) and [Reference][guide].",
    "",
    "![Logo][logo] and [Guide].",
    "",
    "[guide]: guide.md \"Guide title\"",
    "[logo]: assets/logo.png",
  ].join("\n");
  const { html, links } = renderMarkdown(markdown, { rewriteUrl: (url) => ({ href: `/base/${url}` }) });
  assert.match(html, /href="\/base\/guide\.md#part"/);
  assert.match(html, /href="\/base\/guide\.md" title="Guide title"/);
  assert.match(html, /<img src="\/base\/assets\/logo\.png" alt="Logo">/);
  assert.equal(links.length, 4);
});

test("uses GitHub-style heading slugs for punctuation, code, and duplicates", () => {
  const { headings, html } = renderMarkdown([
    "# What's *new* in `v1.0`?",
    "## What's new in v1.0?",
    "## What's new in v1.0?",
    "## Use `foo_bar` safely",
  ].join("\n"));
  assert.deepEqual(headings.map(({ id }) => id), ["whats-new-in-v10", "whats-new-in-v10-1", "whats-new-in-v10-2", "use-foo_bar-safely"]);
  assert.match(html, /id="whats-new-in-v10-2"/);
});

test("rewrites site, anchor, repository file, folder, and asset links", () => {
  const resolver = new LinkResolver({
    root: ROOT,
    base: "/cupel/",
    siteSources: ["docs/install.md", "docs/site/home.md"],
  });
  assert.equal(resolver.rewrite("docs/site/home.md", "../install.md").href, "/cupel/install.html");
  assert.deepEqual(resolver.rewrite("docs/install.md", "#prerequisites"), {
    href: "#prerequisites",
    targetSource: "docs/install.md",
    anchor: "prerequisites",
  });
  assert.equal(resolver.rewrite("docs/install.md", "../LICENSE").href, "https://github.com/Vibernt/cupel/blob/main/LICENSE");
  assert.equal(resolver.rewrite("docs/extending/collectors.md", "demo/").href, "https://github.com/Vibernt/cupel/tree/main/docs/extending/demo/");
  assert.equal(resolver.rewrite("docs/site/home.md", "../assets/cupel-logo.png", { image: true }).href, "/cupel/assets/cupel-logo.png");
  assert.deepEqual(resolver.errors, []);
});

test("reports a missing internal anchor with its page and link", () => {
  const resolver = new LinkResolver({ root: ROOT, base: "/", siteSources: ["docs/install.md"] });
  const rendered = renderMarkdown("# Install\n\n[Missing](#not-here)", { rewriteUrl: resolver.forSource("docs/install.md") });
  const errors = validateAnchors([{ source: "docs/install.md", rendered }], resolver);
  assert.deepEqual(errors, ["docs/install.md: #not-here has no matching anchor"]);
});

async function filesUnder(directory, prefix = "") {
  const files = new Map();
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) {
      for (const [name, bytes] of await filesUnder(directory, relative)) files.set(name, bytes);
    } else if (entry.isFile()) {
      files.set(relative, await readFile(path.join(directory, relative)));
    }
  }
  return files;
}

test("builds the real docs with zero broken links and byte-identical output", async (context) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cupel-site-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const first = path.join(temporary, "first");
  const second = path.join(temporary, "second");
  const firstResult = await buildSite({ root: ROOT, out: first, base: "/cupel/" });
  const secondResult = await buildSite({ root: ROOT, out: second, base: "/cupel/" });
  assert.equal(firstResult.brokenLinks, 0);
  assert.equal(firstResult.pages, 23);
  assert.equal(secondResult.brokenLinks, 0);

  const firstFiles = await filesUnder(first);
  const secondFiles = await filesUnder(second);
  assert.deepEqual([...firstFiles.keys()], [...secondFiles.keys()]);
  for (const [name, bytes] of firstFiles) assert.deepEqual(bytes, secondFiles.get(name), name);
  assert.match(await readFile(path.join(first, "index.html"), "utf8"), /Cupel documentation/);
  assert.match(await readFile(path.join(first, "search-index.json"), "utf8"), /"title": "Rust"/);
  assert.ok((await readFile(path.join(first, "assets/cupel-logo.png"))).byteLength > 0);
});
