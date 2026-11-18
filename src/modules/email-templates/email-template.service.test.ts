import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_TEMPLATES } from "./defaults.js";
import {
  escapeHtml,
  htmlToText,
  renderString,
  renderTemplate,
  sampleVars,
} from "./email-template.service.js";

describe("email templates", () => {
  test("{{name}} is replaced and values are HTML-escaped", () => {
    const out = renderString(
      "<p>{{projectName}} by {{inviterName}}</p>",
      {
        projectName: '<b>Big</b> & "Bold"',
        inviterName: "Aditya",
      },
      true,
    );
    assert.equal(
      out,
      "<p>&lt;b&gt;Big&lt;/b&gt; &amp; &quot;Bold&quot; by Aditya</p>",
    );
  });

  test("a variable with no value becomes empty, and spaces inside braces are fine", () => {
    assert.equal(renderString("a{{ missing }}b", {}, true), "ab");
  });

  test("the subject is not escaped and cannot carry a line break", () => {
    const mail = renderTemplate(
      { subject: "Join {{projectName}}", html: "<p>x</p>" },
      { projectName: "R&D\nBcc: x@evil.example" },
    );
    assert.equal(mail.subject, "Join R&D Bcc: x@evil.example");
    assert.ok(!/[\r\n]/.test(mail.subject));
  });

  test("three braces insert app-built markup as it is, but only for allowed names", () => {
    const html = renderString(
      "{{{taskListHtml}}}|{{{projectName}}}",
      {
        taskListHtml: "<ul><li>ok</li></ul>",
        projectName: "<i>no</i>",
      },
      true,
    );
    assert.equal(html, "<ul><li>ok</li></ul>|&lt;i&gt;no&lt;/i&gt;");
  });

  test("plain text keeps link targets", () => {
    const text = htmlToText(
      '<p>Hello <a href="https://x.test/a?b=1&amp;c=2">open</a></p>',
    );
    assert.equal(text, "Hello open (https://x.test/a?b=1&c=2)");
  });

  test("every default template renders with its own sample values and leaves no braces behind", () => {
    for (const t of DEFAULT_TEMPLATES) {
      const mail = renderTemplate(t, {
        appName: "Pristine",
        websiteUrl: "https://a.test",
        dashboardUrl: "https://a.test/dashboard",
        ...sampleVars(t.variables),
      });
      assert.ok(
        !/\{\{/.test(mail.html) && !/\{\{/.test(mail.subject),
        `${t.code} has an unfilled variable`,
      );
      assert.ok(mail.text.length > 10, `${t.code} has a text version`);
    }
  });

  test("sign-in code templates cannot be switched off", () => {
    for (const code of ["LOGIN_2FA_CODE", "PASSWORD_RESET_CODE"])
      assert.equal(
        DEFAULT_TEMPLATES.find((t) => t.code === code)?.canDisable,
        false,
      );
  });

  test("escapeHtml handles quotes", () => {
    assert.equal(escapeHtml(`"'`), "&quot;&#39;");
  });
});
