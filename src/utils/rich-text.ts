import sanitizeHtml from "sanitize-html";

/**
 * Notes are written in the portal's editor as HTML, but they also arrive as plain text (API clients, agents, older
 * notes). HTML is cleaned on every write so nothing active is ever stored: only the formatting the editor offers
 * and http, https and mailto links survive, and every link is made to open in a new tab without access to ours.
 * Plain text is left exactly as written.
 */

const FORMATTING =
  /<\/?(p|br|h[1-6]|ul|ol|li|strong|em|b|i|u|s|a|blockquote|pre|code|hr|div|span)\b[^>]*>/i;
/** Tags that could run or load something. A note containing one is always cleaned, even if it looks like text. */
const ACTIVE =
  /<\/?(script|style|iframe|object|embed|img|svg|link|meta|form|input|button|textarea|base|math|video|audio|source)\b/i;

export const looksLikeHtml = (value: string): boolean =>
  FORMATTING.test(value) || ACTIVE.test(value);

const OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    "p",
    "br",
    "strong",
    "em",
    "b",
    "i",
    "s",
    "u",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "hr",
    "a",
  ],
  allowedAttributes: { a: ["href", "target", "rel"] },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesAppliedToAttributes: ["href"],
  allowProtocolRelative: false,
  disallowedTagsMode: "discard",
  // Drop the content of tags that hold code, not text.
  nonTextTags: ["script", "style", "textarea", "option", "noscript"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", {
      target: "_blank",
      rel: "noopener noreferrer nofollow",
    }),
  },
};

export const sanitizeRichText = (value: string): string =>
  looksLikeHtml(value) ? sanitizeHtml(value, OPTIONS).trim() : value;

/** The text of a note without formatting, for emptiness checks and previews. */
export const richTextToPlain = (value: string): string =>
  looksLikeHtml(value)
    ? sanitizeHtml(
        value.replace(/<\/(p|li|h[1-6]|blockquote|pre)>|<br\s*\/?>/gi, " $&"),
        {
          allowedTags: [],
          allowedAttributes: {},
          nonTextTags: ["script", "style", "textarea", "option", "noscript"],
        },
      )
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
    : value.trim();
