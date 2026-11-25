import { escapeHtml, renderMarkdown } from "./markdown.mjs";
import { outputPathForSource } from "./links.mjs";

const SITE_ORIGIN = "https://vibernt.github.io/cupel/";

function pageHref(source, base) {
  return `${base}${outputPathForSource(source)}`;
}

export function flattenNavigation(navigation) {
  return navigation.sections.flatMap((section) => section.pages.map((page) => ({
    ...page,
    source: page.source === "site/home.md" ? "docs/site/home.md" : `docs/${page.source}`,
    section: section.title,
  })));
}

export function sidebarHtml(navigation, currentSource, base) {
  return navigation.sections.map((section) => {
    const links = section.pages.map((page) => {
      const source = page.source === "site/home.md" ? "docs/site/home.md" : `docs/${page.source}`;
      const current = source === currentSource ? ' aria-current="page"' : "";
      return `<li><a href="${escapeHtml(pageHref(source, base))}"${current}>${escapeHtml(page.title)}</a></li>`;
    }).join("");
    return `<section class="nav-section"><h2>${escapeHtml(section.title)}</h2><ul>${links}</ul></section>`;
  }).join("\n");
}

export function tocHtml(headings) {
  const entries = headings.filter(({ level }) => level === 2 || level === 3);
  if (entries.length === 0) return '<p class="toc-empty">No sections on this page.</p>';
  return `<ol>${entries.map(({ level, id, text }) => `<li class="toc-level-${level}"><a href="#${escapeHtml(id)}">${escapeHtml(text)}</a></li>`).join("")}</ol>`;
}

export function paginationHtml(pages, index, base) {
  const previous = pages[index - 1];
  const next = pages[index + 1];
  const card = (page, relation, label) => page
    ? `<a class="page-link page-link-${relation}" href="${escapeHtml(pageHref(page.source, base))}"><span>${label}</span><strong>${escapeHtml(page.title)}</strong></a>`
    : "<span></span>";
  return `<nav class="page-pagination" aria-label="Documentation pages">${card(previous, "previous", "Previous")}${card(next, "next", "Next")}</nav>`;
}

export function descriptionFor(page) {
  const withoutTitle = page.rendered.text.replace(new RegExp(`^${page.rendered.headings[0]?.text ?? ""}\\s*`), "");
  const description = (withoutTitle || page.rendered.text || `Cupel documentation: ${page.title}`).trim();
  return description.length > 157 ? `${description.slice(0, 154).trimEnd()}…` : description;
}

function replaceAll(template, values) {
  return template.replace(/{{([A-Z_]+)}}/g, (_match, key) => {
    if (!(key in values)) throw new Error(`template placeholder is unresolved: ${key}`);
    return values[key];
  });
}

export function renderPage({ template, page, pages, index, navigation, version, base, searchIndex }) {
  const title = page.source === "docs/site/home.md" ? "Cupel documentation" : `${page.title} · Cupel`;
  const description = descriptionFor(page);
  const outputPath = outputPathForSource(page.source);
  const canonical = new URL(outputPath, SITE_ORIGIN).href;
  const searchJson = JSON.stringify(searchIndex).replace(/<\//g, "<\\/");
  return replaceAll(template, {
    BASE: escapeHtml(base),
    TITLE: escapeHtml(title),
    DESCRIPTION: escapeHtml(description),
    CANONICAL: escapeHtml(canonical),
    OG_IMAGE: `${SITE_ORIGIN}assets/cupel-logo.png`,
    VERSION: escapeHtml(version),
    SIDEBAR: sidebarHtml(navigation, page.source, base),
    TOC: tocHtml(page.rendered.headings),
    CONTENT: page.rendered.html,
    PAGINATION: paginationHtml(pages, index, base),
    EDIT_URL: `https://github.com/Vibernt/cupel/edit/main/${page.source.split("/").map(encodeURIComponent).join("/")}`,
    SEARCH_INDEX: searchJson,
    ROBOTS: "index, follow",
  });
}

export function renderNotFound({ template, navigation, version, base, searchIndex }) {
  const rendered = renderMarkdown("# Page not found\n\nThe page you requested is not part of the Cupel documentation site.\n\n[Go to the documentation home](site/home.md).", {
    rewriteUrl: (url) => url === "site/home.md" ? { href: `${base}index.html` } : { href: url },
  });
  const page = { title: "Page not found", source: "docs/site/home.md", rendered };
  const html = renderPage({ template, page, pages: [page], index: 0, navigation, version, base, searchIndex });
  return html
    .replaceAll('content="Cupel documentation"', 'content="Page not found · Cupel"')
    .replace("Cupel documentation</title>", "Page not found · Cupel</title>")
    .replaceAll(`${SITE_ORIGIN}index.html`, `${SITE_ORIGIN}404.html`)
    .replace('content="index, follow"', 'content="noindex"')
    .replace(/<a class="edit-link"[\s\S]*?<\/a>/, "");
}
