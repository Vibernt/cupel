import { lstatSync } from "node:fs";
import path from "node:path";

const GITHUB_ROOT = "https://github.com/Vibernt/cupel";

export function normalizeBase(value) {
  if (!value.startsWith("/")) throw new Error(`base path must start with /: ${value}`);
  return value.endsWith("/") ? value : `${value}/`;
}

export function outputPathForSource(source) {
  if (source === "docs/site/home.md") return "index.html";
  return source.replace(/^docs\//, "").replace(/\.md$/i, ".html");
}

function splitUrl(value) {
  const hashAt = value.indexOf("#");
  const beforeHash = hashAt === -1 ? value : value.slice(0, hashAt);
  const hash = hashAt === -1 ? "" : value.slice(hashAt);
  const queryAt = beforeHash.indexOf("?");
  return {
    pathname: queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt),
    query: queryAt === -1 ? "" : beforeHash.slice(queryAt),
    hash,
  };
}

function repositoryUrl(kind, repositoryPath, query, hash) {
  const encoded = repositoryPath.split("/").map(encodeURIComponent).join("/");
  return `${GITHUB_ROOT}/${kind}/main/${encoded}${query}${hash}`;
}

export class LinkResolver {
  constructor({ root, base, siteSources }) {
    this.root = root;
    this.base = normalizeBase(base);
    this.siteSources = new Set(siteSources);
    this.assets = new Set();
    this.errors = [];
  }

  forSource(source) {
    return (url, { image = false } = {}) => this.rewrite(source, url, { image });
  }

  rewrite(source, url, { image = false } = {}) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return { href: url };
    if (url.startsWith("#")) return { href: url, targetSource: source, anchor: url.slice(1) };
    if (url.startsWith("/")) return { href: url };

    const { pathname, query, hash } = splitUrl(url);
    if (!pathname) return { href: `${query}${hash}` };
    const repositoryPath = path.posix.normalize(path.posix.join(path.posix.dirname(source), pathname));
    if (repositoryPath.startsWith("../") || path.posix.isAbsolute(repositoryPath)) {
      this.errors.push(`${source}: ${url} leaves the repository`);
      return { href: "#" };
    }

    if (this.siteSources.has(repositoryPath)) {
      const output = outputPathForSource(repositoryPath);
      return {
        href: `${this.base}${output}${query}${hash}`,
        targetSource: repositoryPath,
        anchor: hash ? decodeURIComponent(hash.slice(1)) : "",
      };
    }

    let stat;
    try {
      stat = lstatSync(path.join(this.root, ...repositoryPath.split("/")));
    } catch {
      this.errors.push(`${source}: ${url} does not exist`);
      return { href: "#" };
    }

    if (image && repositoryPath.startsWith("docs/assets/") && stat.isFile()) {
      const asset = repositoryPath.slice("docs/assets/".length);
      this.assets.add(repositoryPath);
      return { href: `${this.base}assets/${asset}${query}${hash}` };
    }

    return {
      href: repositoryUrl(stat.isDirectory() ? "tree" : "blob", repositoryPath, query, hash),
    };
  }
}

export function validateAnchors(pages, resolver) {
  const anchors = new Map(pages.map((page) => [page.source, new Set(page.rendered.headings.map(({ id }) => id))]));
  for (const page of pages) {
    for (const link of page.rendered.links) {
      if (!link.targetSource || !link.anchor) continue;
      if (!anchors.get(link.targetSource)?.has(link.anchor)) {
        resolver.errors.push(`${page.source}: ${link.original} has no matching anchor`);
      }
    }
  }
  return resolver.errors;
}
