const root = document.documentElement;
const search = document.querySelector("#site-search");
const results = document.querySelector("#search-results");
const menu = document.querySelector(".mobile-menu");
const sidebar = document.querySelector("#site-sidebar");
const theme = document.querySelector(".theme-toggle");
const index = JSON.parse(document.querySelector("#search-index")?.textContent || "[]");
let selected = -1;

try {
  const saved = localStorage.getItem("cupel-theme");
  if (saved === "light" || saved === "dark") root.dataset.theme = saved;
} catch {}

theme?.addEventListener("click", () => {
  const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("cupel-theme", next); } catch {}
});

menu?.addEventListener("click", () => {
  const open = menu.getAttribute("aria-expanded") !== "true";
  menu.setAttribute("aria-expanded", String(open));
  sidebar?.classList.toggle("is-open", open);
});

function searchDocs() {
  const query = search.value.trim().toLowerCase();
  selected = -1;
  if (!query) {
    results.hidden = true;
    search.setAttribute("aria-expanded", "false");
    return;
  }
  const matches = index.filter((page) => `${page.title} ${page.headings.join(" ")} ${page.text}`.toLowerCase().includes(query)).slice(0, 8);
  results.replaceChildren();
  if (matches.length) {
    matches.forEach((page, item) => {
      const link = document.createElement("a");
      const title = document.createElement("strong");
      const headings = document.createElement("span");
      link.href = page.url;
      link.role = "option";
      link.dataset.item = item;
      title.textContent = page.title;
      headings.textContent = page.headings.slice(0, 2).join(" · ");
      link.append(title, headings);
      results.append(link);
    });
  } else {
    const empty = document.createElement("p");
    empty.textContent = "No matching pages.";
    results.append(empty);
  }
  results.hidden = false;
  search.setAttribute("aria-expanded", "true");
}

search?.addEventListener("input", searchDocs);
search?.addEventListener("keydown", (event) => {
  const options = [...results.querySelectorAll("a")];
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    selected = event.key === "ArrowDown" ? Math.min(selected + 1, options.length - 1) : Math.max(selected - 1, 0);
    options.forEach((option, item) => option.toggleAttribute("aria-selected", item === selected));
    options[selected]?.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter" && selected >= 0) {
    options[selected]?.click();
  } else if (event.key === "Escape") {
    results.hidden = true;
    search.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) {
    event.preventDefault();
    search?.focus();
  }
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".search")) {
    results.hidden = true;
    search?.setAttribute("aria-expanded", "false");
  }
});
