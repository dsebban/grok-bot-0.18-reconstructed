import { Marked } from "marked";

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

const SAFE_URL = /^(https?:|mailto:|#|\/)/i;

/**
 * Markdown for model output. Raw HTML is shown as text, and links and images
 * keep only http(s), mailto and relative targets, so model output cannot
 * inject markup or script.
 */
const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    html({ text }) {
      return escapeHtml(text);
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!SAFE_URL.test(href)) return label;
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
      return `<a href="${escapeHtml(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, text }) {
      if (!/^https?:/i.test(href)) return escapeHtml(text);
      return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}" loading="lazy" />`;
    }
  }
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false });
}
