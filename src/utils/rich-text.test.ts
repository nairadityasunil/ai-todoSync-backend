import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  looksLikeHtml,
  richTextToPlain,
  sanitizeRichText,
} from "./rich-text.js";

describe("sanitizeRichText", () => {
  it("keeps the formatting the editor offers", () => {
    const html =
      "<h2>Plan</h2><p>Use <strong>bold</strong>, <em>italic</em> and <code>code</code></p><ul><li>one</li></ul><blockquote>q</blockquote>";
    assert.equal(sanitizeRichText(html), html);
  });

  it("removes scripts and their content", () => {
    const out = sanitizeRichText("<p>hi</p><script>alert(1)</script>");
    assert.equal(out, "<p>hi</p>");
  });

  it("removes event handlers and tags that load things", () => {
    const out = sanitizeRichText(
      '<p onclick="x()">a</p><img src=x onerror="alert(1)"><iframe src="https://evil.test"></iframe>',
    );
    assert.equal(out, "<p>a</p>");
  });

  it("refuses javascript: and data: links but keeps https and mailto", () => {
    assert.ok(
      !sanitizeRichText('<a href="javascript:alert(1)">x</a>').includes(
        "javascript",
      ),
    );
    assert.ok(
      !sanitizeRichText('<a href="data:text/html;base64,AAAA">x</a>').includes(
        "data:",
      ),
    );
    assert.ok(
      sanitizeRichText('<a href="https://example.com/a?b=1">x</a>').includes(
        'href="https://example.com/a?b=1"',
      ),
    );
    assert.ok(
      sanitizeRichText('<a href="mailto:a@b.co">x</a>').includes(
        "mailto:a@b.co",
      ),
    );
  });

  it("makes every link open in a new tab without access to ours", () => {
    const out = sanitizeRichText(
      '<a href="https://example.com" target="_self" rel="opener">x</a>',
    );
    assert.match(out, /target="_blank"/);
    assert.match(out, /rel="noopener noreferrer nofollow"/);
    assert.ok(!out.includes('opener"'));
  });

  it("leaves plain text exactly as written", () => {
    const plain = "if a < b and c > d\nsecond line & more";
    assert.equal(sanitizeRichText(plain), plain);
  });

  it("cleans text that hides an active tag", () => {
    assert.equal(
      sanitizeRichText("see <script>alert(1)</script> this"),
      "see  this",
    );
  });
});

describe("richTextToPlain / looksLikeHtml", () => {
  it("reads the text of formatted notes with blocks apart", () => {
    assert.equal(
      richTextToPlain("<p>one</p><p>two &amp; three</p>"),
      "one two & three",
    );
  });
  it("treats an empty paragraph as empty", () => {
    assert.equal(richTextToPlain("<p></p>"), "");
    assert.equal(richTextToPlain("<p><br></p>"), "");
  });
  it("tells formatted from plain", () => {
    assert.equal(looksLikeHtml("<p>x</p>"), true);
    assert.equal(looksLikeHtml("just words"), false);
    assert.equal(looksLikeHtml("1 < 2"), false);
  });
});
