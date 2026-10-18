/**
 * Import limits, in one place so the parser, the route, the server action and
 * the JSON envelope schema cannot disagree about what "too big" means.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 1000;
/** Enough to fix the file; the counts say how many more there were. */
export const MAX_REPORTED_PROBLEMS = 50;
