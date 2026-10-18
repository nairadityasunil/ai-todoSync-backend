/** Escapes text so it matches literally inside a RegExp or Mongo $regex. */
export const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
