import { existsSync } from "node:fs";
import { resolve as pathResolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const sourceRoot = pathResolve(process.cwd(), "src");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const unresolved = pathResolve(sourceRoot, specifier.slice(2));
  const normalized = pathResolve(unresolved);
  if (!normalized.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error("Refusing to resolve a test import outside src/.");
  }

  const hasRuntimeExtension = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(normalized);
  const candidates = hasRuntimeExtension
    ? [normalized]
    : [`${normalized}.ts`, `${normalized}.tsx`, `${normalized}.js`, pathResolve(normalized, "index.ts")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`Unable to resolve test import ${specifier}.`);

  return { url: pathToFileURL(path).href, shortCircuit: true };
}
