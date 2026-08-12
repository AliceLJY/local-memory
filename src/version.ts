import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { metaDir } from "./compat.js";

type PackageMetadata = {
  version?: unknown;
};

const packageMetadata = JSON.parse(
  readFileSync(resolve(metaDir(import.meta), "../package.json"), "utf8"),
) as PackageMetadata;

if (typeof packageMetadata.version !== "string" || packageMetadata.version.length === 0) {
  throw new Error("package.json must contain a non-empty version");
}

/** The public RecallNest version. package.json is the single source of truth. */
export const PACKAGE_VERSION = packageMetadata.version;
