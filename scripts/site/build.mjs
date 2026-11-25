#!/usr/bin/env node
import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LinkResolver, normalizeBase, outputPathForSource, validateAnchors } from "./links.mjs";
import { renderMarkdown } from "./markdown.mjs";
import { flattenNavigation, renderNotFound, renderPage } from "./page.mjs";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIRECTORY, "../..");

function parseArguments(arguments_) {
  const options = { out: "_site", base: "/cupel/" };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--out" || argument === "--base") {
      const value = arguments_[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} needs a value`);
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

async function copyDirectory(source, destination) {
  await mkdir(destination, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function copyImages(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyImages(from, to);
    } else if (entry.isFile() && /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(entry.name)) {
      await mkdir(path.dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

async function prepareOutput(root, output) {
  const resolved = path.resolve(root, output);
  const filesystemRoot = path.parse(resolved).root;
  if (resolved === root || resolved === filesystemRoot) throw new Error(`refusing to replace unsafe output directory: ${resolved}`);
  await rm(resolved, { recursive: true, force: true });
  await mkdir(resolved, { recursive: true });
  return resolved;
}

async function loadNavigation(root) {
  const file = path.join(root, "docs/site/nav.json");
  const navigation = JSON.parse(await readFile(file, "utf8"));
  if (!Array.isArray(navigation.sections) || navigation.sections.length === 0) throw new Error("docs/site/nav.json needs sections");
  const pages = flattenNavigation(navigation);
  const sources = new Set();
  for (const page of pages) {
    if (!page.title || !page.source) throw new Error("every nav page needs title and source");
    if (sources.has(page.source)) throw new Error(`nav page is repeated: ${page.source}`);
    sources.add(page.source);
    await stat(path.join(root, ...page.source.split("/")));
  }
  return { navigation, pages };
}

export async function buildSite({ root = DEFAULT_ROOT, out = "_site", base = "/cupel/" } = {}) {
  const normalizedBase = normalizeBase(base);
  const output = await prepareOutput(root, out);
  const [{ navigation, pages }, packageJson, template] = await Promise.all([
    loadNavigation(root),
    readFile(path.join(root, "packages/cupel/package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "docs/site/template.html"), "utf8"),
  ]);
  const resolver = new LinkResolver({ root, base: normalizedBase, siteSources: pages.map(({ source }) => source) });

  for (const page of pages) {
    page.markdown = await readFile(path.join(root, ...page.source.split("/")), "utf8");
    page.rendered = renderMarkdown(page.markdown, { rewriteUrl: resolver.forSource(page.source) });
    if (!page.rendered.headings.some(({ level }) => level === 1)) resolver.errors.push(`${page.source}: page has no h1 heading`);
  }
  validateAnchors(pages, resolver);
  if (resolver.errors.length) {
    throw new Error(`broken internal links (${resolver.errors.length}):\n${resolver.errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const searchIndex = pages.map((page) => ({
    title: page.title,
    url: `${normalizedBase}${outputPathForSource(page.source)}`,
    headings: page.rendered.headings.filter(({ level }) => level > 1).map(({ text }) => text),
    text: page.rendered.text,
  }));

  for (const [index, page] of pages.entries()) {
    const destination = path.join(output, ...outputPathForSource(page.source).split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, renderPage({
      template,
      page,
      pages,
      index,
      navigation,
      version: packageJson.version,
      base: normalizedBase,
      searchIndex,
    }));
  }

  await Promise.all([
    writeFile(path.join(output, "404.html"), renderNotFound({
      template,
      navigation,
      version: packageJson.version,
      base: normalizedBase,
      searchIndex,
    })),
    writeFile(path.join(output, "search-index.json"), `${JSON.stringify(searchIndex, null, 2)}\n`),
    copyFile(path.join(root, "docs/site/site.css"), path.join(output, "site.css")),
    copyFile(path.join(root, "docs/site/site.js"), path.join(output, "site.js")),
    copyDirectory(path.join(root, "docs/site/vendor"), path.join(output, "vendor")),
    copyImages(path.join(root, "docs/assets"), path.join(output, "assets")),
  ]);

  return { output, pages: pages.length, brokenLinks: 0 };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await buildSite(options);
  process.stdout.write(`Built ${result.pages} pages in ${result.output}; ${result.brokenLinks} broken links.\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
