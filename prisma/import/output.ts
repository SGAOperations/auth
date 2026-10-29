import { writeFile } from "node:fs/promises";
import { ImportInputError } from "./chambers.js";

// Output writer shared by the import and reconcile scripts.

/** Never overwrites: an existing file means the data was already written. */
export async function writeOutput(
  path: string,
  value: unknown,
  committed: boolean,
) {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new ImportInputError(
        `Output file ${path} already exists.${committed ? " The import was committed; re-run with a fresh --out." : " Use a fresh --out."}`,
      );
    }
    throw error;
  }
}
