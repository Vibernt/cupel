const ENTITY = /&(?!(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);)/gi;

export function escapeHtml(value, { preserveEntities = false } = {}) {
  const ampersand = preserveEntities ? ENTITY : /&/g;
  return String(value)
    .replace(ampersand, "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function githubSlug(value) {
  return stripSlugPunctuation(plainInline(value).toLowerCase().trim())
    .replace(/\s+/gu, "-");
}

// JavaScript does not support character-class subtraction everywhere Node 22 runs.
// Keep GitHub's hyphens and underscores while dropping other punctuation/symbols.
function stripSlugPunctuation(value) {
  return [...value].filter((character) => {
    if (character === "-" || character === "_") return true;
    return !/[\p{P}\p{S}]/u.test(character);
  }).join("");
}

export function slugger() {
  const seen = new Map();
  return (heading) => {
    const base = stripSlugPunctuation(plainInline(heading).toLowerCase().trim())
      .replace(/\s+/gu, "-");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
}

function plainInline(value) {
  return String(value)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/!\[([^\]]*)\]\[[^\]]*\]/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, "$1")
    .replace(/[`*~]/g, "")
    .replace(/\\([\\`*{}\[\]()#+.!|_-])/g, "$1")
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ({
      "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'",
    })[entity] ?? entity);
}

function parseReferences(markdown) {
  const references = new Map();
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const kept = [];
  for (const line of lines) {
    const match = line.match(/^ {0,3}\[([^\]]+)\]:\s*(?:<([^>]+)>|(\S+))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/);
    if (!match) {
      kept.push(line);
      continue;
    }
    references.set(match[1].trim().toLowerCase(), {
      url: match[2] ?? match[3],
      title: match[4] ?? match[5] ?? match[6] ?? "",
    });
  }
  return { lines: kept, references };
}

function splitDestination(destination) {
  const trimmed = destination.trim();
  const match = trimmed.match(/^(?:<([^>]+)>|(\S+?))(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?$/);
  if (!match) return { url: trimmed, title: "" };
  return { url: match[1] ?? match[2], title: match[3] ?? match[4] ?? match[5] ?? "" };
}

function renderInline(value, context) {
  const tokens = [];
  const stash = (html) => `\u0000${tokens.push(html) - 1}\u0000`;
  let text = String(value);

  text = text.replace(/(`+)([\s\S]*?)\1/g, (_match, ticks, code) => {
    const normalized = code.replace(/\n/g, " ").replace(/^ | $/g, "");
    return stash(`<code>${escapeHtml(normalized)}</code>`);
  });

  text = text.replace(/\\([\\`*{}\[\]()#+.!|_-])/g, (_match, character) => stash(escapeHtml(character)));

  const makeLink = (label, destination, image) => {
    const { url, title } = splitDestination(destination);
    const rewritten = context.rewriteUrl?.(url, { image }) ?? { href: url };
    context.links.push({ original: url, ...rewritten });
    const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
    if (image) {
      return stash(`<img src="${escapeHtml(rewritten.href)}" alt="${escapeHtml(plainInline(label))}"${titleAttribute}>`);
    }
    const labelHtml = renderInline(label, { ...context, allowLinks: false });
    return stash(`<a href="${escapeHtml(rewritten.href)}"${titleAttribute}>${labelHtml}</a>`);
  };

  if (context.allowLinks !== false) {
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, destination) => makeLink(alt, destination, true));
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, destination) => makeLink(label, destination, false));
    text = text.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (match, alt, id) => {
      const reference = context.references.get((id || alt).trim().toLowerCase());
      return reference ? makeLink(alt, `${reference.url}${reference.title ? ` "${reference.title}"` : ""}`, true) : match;
    });
    text = text.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (match, label, id) => {
      const reference = context.references.get((id || label).trim().toLowerCase());
      return reference ? makeLink(label, `${reference.url}${reference.title ? ` "${reference.title}"` : ""}`, false) : match;
    });
    text = text.replace(/!\[([^\]]+)\]/g, (match, alt) => {
      const reference = context.references.get(alt.trim().toLowerCase());
      return reference ? makeLink(alt, `${reference.url}${reference.title ? ` "${reference.title}"` : ""}`, true) : match;
    });
    text = text.replace(/\[([^\]]+)\]/g, (match, label) => {
      const reference = context.references.get(label.trim().toLowerCase());
      return reference ? makeLink(label, `${reference.url}${reference.title ? ` "${reference.title}"` : ""}`, false) : match;
    });
    text = text.replace(/<((?:https?:\/\/|mailto:)[^ >]+)>/g, (_match, url) => makeLink(url, url, false));
  }

  text = escapeHtml(text, { preserveEntities: true });
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "<em>$1</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/ {2,}\n|\\\n/g, "<br>\n");

  return text.replace(/\u0000(\d+)\u0000/g, (_match, index) => tokens[Number(index)]);
}

function splitTableRow(line) {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let ticks = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "`") {
      const start = index;
      while (source[index + 1] === "`") index += 1;
      const run = index - start + 1;
      ticks = ticks === 0 ? run : (ticks === run ? 0 : ticks);
      cell += "`".repeat(run);
    } else if (character === "|" && ticks === 0) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function tableDelimiter(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0 || cells.some((cell) => !/^:?-{3,}:?$/.test(cell.replace(/\s/g, "")))) return null;
  return cells.map((cell) => {
    const compact = cell.replace(/\s/g, "");
    if (compact.startsWith(":") && compact.endsWith(":")) return "center";
    if (compact.endsWith(":")) return "right";
    return "left";
  });
}

function isFence(line) {
  return line.match(/^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)?.*$/);
}

function isList(line) {
  return line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
}

function isHorizontalRule(line) {
  return /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
}

function rawHtmlStart(line) {
  const match = line.match(/^ {0,3}<([a-z][a-z0-9-]*)(?:\s|>|\/)/i);
  if (!match) return null;
  return match[1].toLowerCase();
}

function highlight(code, language) {
  const escaped = escapeHtml(code);
  if (!/^(?:sh|shell|bash|json|js|javascript)$/.test(language)) return escaped;
  if (/^(?:sh|shell|bash)$/.test(language)) {
    return escaped.replace(/(^|\s)(export|if|then|fi|for|do|done)(?=\s|$)/gm, '$1<span class="tok-keyword">$2</span>');
  }
  if (language === "json") {
    return escaped
      .replace(/(&quot;[^&\n]*?&quot;)(\s*:)/g, '<span class="tok-key">$1</span>$2')
      .replace(/\b(true|false|null)\b/g, '<span class="tok-keyword">$1</span>');
  }
  return escaped.replace(/\b(const|let|function|return|if|else|await|async|import|export|from|new|class)\b/g, '<span class="tok-keyword">$1</span>');
}

function unwrapSingleParagraph(html) {
  const trimmed = html.trim();
  if (/^<p>[\s\S]*<\/p>$/.test(trimmed) && !trimmed.slice(3, -4).includes("<p>")) return trimmed.slice(3, -4);
  return trimmed.replace(/^<p>([^<]*)<\/p>\n(?=<(?:ul|ol)>)/, "$1\n");
}

export function renderMarkdown(markdown, { rewriteUrl } = {}) {
  const { lines, references } = parseReferences(markdown);
  const headings = [];
  const links = [];
  const nextSlug = slugger();
  const context = { references, links, rewriteUrl, allowLinks: true };

  function renderBlocks(blockLines) {
    const html = [];
    let index = 0;
    while (index < blockLines.length) {
      const line = blockLines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = isFence(line);
      if (fence) {
        const marker = fence[1][0];
        const minimum = fence[1].length;
        const language = (fence[2] ?? "").toLowerCase();
        const code = [];
        index += 1;
        while (index < blockLines.length && !new RegExp(`^ {0,3}${marker}{${minimum},}\\s*$`).test(blockLines[index])) {
          code.push(blockLines[index]);
          index += 1;
        }
        if (index < blockLines.length) index += 1;
        const className = language ? ` class="language-${escapeHtml(language)}"` : "";
        html.push(`<pre><code${className}>${highlight(code.join("\n"), language)}</code></pre>`);
        continue;
      }

      const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        const label = heading[2];
        const id = nextSlug(label);
        const text = plainInline(label);
        headings.push({ level, id, text });
        html.push(`<h${level} id="${escapeHtml(id)}">${renderInline(label, context)}<a class="heading-anchor" href="#${escapeHtml(id)}" aria-label="Link to ${escapeHtml(text)}">#</a></h${level}>`);
        index += 1;
        continue;
      }

      if (isHorizontalRule(line)) {
        html.push("<hr>");
        index += 1;
        continue;
      }

      if (line.match(/^ {0,3}>/)) {
        const quoted = [];
        while (index < blockLines.length && (blockLines[index].match(/^ {0,3}> ?/) || !blockLines[index].trim())) {
          quoted.push(blockLines[index].replace(/^ {0,3}> ?/, ""));
          index += 1;
        }
        html.push(`<blockquote>${renderBlocks(quoted)}</blockquote>`);
        continue;
      }

      const rawTag = rawHtmlStart(line);
      if (rawTag) {
        const raw = [line];
        index += 1;
        if (!/\/>\s*$/.test(line) && !new RegExp(`</${rawTag}>`, "i").test(line) && !["img", "hr", "br", "meta", "link", "source"].includes(rawTag)) {
          while (index < blockLines.length) {
            raw.push(blockLines[index]);
            const done = new RegExp(`</${rawTag}>`, "i").test(blockLines[index]);
            index += 1;
            if (done) break;
          }
        }
        html.push(raw.join("\n"));
        continue;
      }

      const delimiter = index + 1 < blockLines.length ? tableDelimiter(blockLines[index + 1]) : null;
      if (delimiter && line.includes("|")) {
        const header = splitTableRow(line);
        const rows = [];
        index += 2;
        while (index < blockLines.length && blockLines[index].includes("|") && blockLines[index].trim()) {
          rows.push(splitTableRow(blockLines[index]));
          index += 1;
        }
        const cells = (row, tag) => delimiter.map((alignment, cellIndex) => `<${tag} class="align-${alignment}">${renderInline(row[cellIndex] ?? "", context)}</${tag}>`).join("");
        html.push(`<div class="table-wrap"><table><thead><tr>${cells(header, "th")}</tr></thead><tbody>${rows.map((row) => `<tr>${cells(row, "td")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }

      const list = isList(line);
      if (list) {
        const baseIndent = list[1].length;
        const ordered = /^\d/.test(list[2]);
        const tag = ordered ? "ol" : "ul";
        const start = ordered ? Number.parseInt(list[2], 10) : 1;
        const items = [];
        while (index < blockLines.length) {
          const item = isList(blockLines[index]);
          if (!item || item[1].length !== baseIndent || /^\d/.test(item[2]) !== ordered) break;
          const content = [item[3]];
          index += 1;
          while (index < blockLines.length) {
            const next = isList(blockLines[index]);
            if (next && next[1].length === baseIndent) break;
            if (next && next[1].length < baseIndent) break;
            if (blockLines[index].trim() && blockLines[index].match(/^\s*/)[0].length <= baseIndent && !next) break;
            content.push(blockLines[index].slice(Math.min(blockLines[index].length, baseIndent + 2)));
            index += 1;
          }
          items.push(`<li>${unwrapSingleParagraph(renderBlocks(content))}</li>`);
        }
        const startAttribute = ordered && start !== 1 ? ` start="${start}"` : "";
        html.push(`<${tag}${startAttribute}>${items.join("")}</${tag}>`);
        continue;
      }

      const paragraph = [line];
      index += 1;
      while (index < blockLines.length && blockLines[index].trim()) {
        const candidate = blockLines[index];
        if (isFence(candidate) || /^ {0,3}#{1,6}\s+/.test(candidate) || isHorizontalRule(candidate) || candidate.match(/^ {0,3}>/) || isList(candidate) || rawHtmlStart(candidate)) break;
        if (index + 1 < blockLines.length && candidate.includes("|") && tableDelimiter(blockLines[index + 1])) break;
        paragraph.push(candidate);
        index += 1;
      }
      html.push(`<p>${renderInline(paragraph.join("\n"), context)}</p>`);
    }
    return html.join("\n");
  }

  const html = renderBlocks(lines);
  const text = plainInline(markdown
    .replace(/^ {0,3}\[[^\]]+\]:.*$/gm, "")
    .replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, "")
    .replace(/^ {0,3}[#>*+-]+\s*/gm, "")
    .replace(/^ {0,3}\d+[.)]\s+/gm, "")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return { html, headings, links, text };
}
