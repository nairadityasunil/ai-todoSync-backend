import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildAssignmentEmail } from "./task-assignment-mail.js";

describe("task assignment email", () => {
  it("names who assigned it, the task and where to open it", () => {
    const m = buildAssignmentEmail({
      assigneeName: "Bob",
      assignerName: "Ada",
      projectName: "Website",
      tasks: [
        {
          title: "Fix the footer",
          priority: "HIGH",
          dueDate: "2026-11-20",
          link: "https://app.example/projects/1?task=2",
        },
      ],
    });
    assert.match(
      m.subject,
      /Ada assigned you a task in Website: Fix the footer/,
    );
    assert.match(m.text, /Hello Bob/);
    assert.match(m.text, /high priority/);
    assert.match(m.text, /due 2026-11-20/);
    assert.match(m.text, /https:\/\/app\.example\/projects\/1\?task=2/);
    assert.match(m.html, /href="https:\/\/app\.example\/projects\/1\?task=2"/);
  });
  it("summarises a batch in one email", () => {
    const m = buildAssignmentEmail({
      assigneeName: "Bob",
      assignerName: "Ada",
      tasks: [1, 2, 3].map((n) => ({
        title: `Task ${n}`,
        link: `https://x/${n}`,
      })),
    });
    assert.match(m.subject, /assigned you 3 tasks/);
    assert.equal((m.html.match(/<li /g) ?? []).length, 3);
  });
  it("escapes what people typed", () => {
    const m = buildAssignmentEmail({
      assigneeName: "<b>Bob</b>",
      assignerName: "Ada",
      tasks: [{ title: '<script>alert("x")</script>', link: "https://x/1" }],
    });
    assert.ok(!m.html.includes("<script>"));
    assert.ok(m.html.includes("&lt;script&gt;"));
  });
});
