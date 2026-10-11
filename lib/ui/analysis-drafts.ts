import type { SourceFile } from "../domain/types";
export type AnalysisDraft = {
  files: SourceFile[];
  savedFiles: SourceFile[];
  updatedAt: string;
};
// Draft identity follows immutable files, not observation or endpoint metadata.
// This is a storage identity, not a security signature.
export function analysisFilesDigest(files: SourceFile[]) {
  const value = JSON.stringify(files);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++)
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16) + ":" + value.length;
}
export function draftKey(account: string, project: string) {
  return `waypoint:analysis:v1:${encodeURIComponent(account)}:${encodeURIComponent(project)}`;
}
export function readDraft(
  storage: Pick<Storage, "getItem">,
  key: string,
  sourceFiles: SourceFile[],
): AnalysisDraft | null {
  try {
    const input = JSON.parse(storage.getItem(key) ?? "null");
    if (
      !input ||
      !Array.isArray(input.files) ||
      !Array.isArray(input.savedFiles)
    )
      return null;
    const valid = (files: SourceFile[]) =>
      files.length === sourceFiles.length &&
      files.every(
        (f: SourceFile) =>
          sourceFiles.some((s) => s.id === f.id && s.name === f.name) &&
          typeof f.content === "string" &&
          f.content.length <= 2000000,
      );
    return valid(input.files) && valid(input.savedFiles) ? input : null;
  } catch {
    return null;
  }
}
export function writeDraft(
  storage: Pick<Storage, "setItem">,
  key: string,
  draft: AnalysisDraft,
) {
  storage.setItem(key, JSON.stringify(draft));
}
