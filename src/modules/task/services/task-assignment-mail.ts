/** The email a person gets when someone else gives them a task. Pure: no database, no sending. */

export interface AssignmentMailInput {
  assigneeName: string;
  assignerName: string;
  tasks: Array<{
    title: string;
    priority?: string | null;
    dueDate?: string | null;
    link: string;
  }>;
  projectName?: string | null;
}

const esc = (v: string): string =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );

export function buildAssignmentEmail(i: AssignmentMailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const many = i.tasks.length > 1;
  const where = i.projectName ? ` in ${i.projectName}` : "";
  const subject = many
    ? `${i.assignerName} assigned you ${i.tasks.length} tasks${where}`
    : `${i.assignerName} assigned you a task${where}: ${i.tasks[0].title}`.slice(
        0,
        200,
      );
  const line = (t: AssignmentMailInput["tasks"][number]) =>
    `${t.title}${t.priority ? ` (${t.priority.toLowerCase()} priority)` : ""}${t.dueDate ? `, due ${t.dueDate}` : ""}\n${t.link}`;
  const text = `Hello ${i.assigneeName},\n\n${i.assignerName} assigned you ${many ? `${i.tasks.length} tasks` : "a task"}${where}.\n\n${i.tasks.map(line).join("\n\n")}\n\nYou can open ${many ? "them" : "it"} in Pristine with the link${many ? "s" : ""} above.`;
  const items = i.tasks
    .map(
      (t) =>
        `<li style="margin-bottom:10px"><a href="${esc(t.link)}" style="color:#1c2d27;font-weight:700;text-decoration:none">${esc(t.title)}</a>${t.priority ? ` <span style="color:#52635c">· ${esc(t.priority.toLowerCase())} priority</span>` : ""}${t.dueDate ? ` <span style="color:#52635c">· due ${esc(t.dueDate)}</span>` : ""}</li>`,
    )
    .join("");
  const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f8faf9;margin:0;padding:32px 0"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e1e7e3;border-radius:16px;padding:32px"><h2 style="margin:0 0 8px;color:#1c2d27">${many ? `${i.tasks.length} tasks` : "A task"} assigned to you</h2><p style="color:#52635c;margin:0 0 20px">${esc(i.assignerName)} assigned you ${many ? "these tasks" : "this task"}${esc(where)}.</p><ul style="padding-left:18px;margin:0 0 20px">${items}</ul><p style="color:#84998e;font-size:12px;margin:0">Sent by Pristine.</p></div></body></html>`;
  return { subject, text, html };
}
