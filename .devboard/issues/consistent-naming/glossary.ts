import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isRecord } from "../guards";
import {
  GLOSSARY_DIRECTORY,
  GLOSSARY_SUFFIX,
  consistentNamingConfig,
  type ConsistentNamingConfig,
} from "./paths";

/**
 * The published UbiLang glossaries, read as the authoritative vocabulary of
 * their bounded contexts. Discover owns `.omp/discover/glossary/**`; this
 * module only reads it, never writes it. A glossary a cycle cannot parse
 * contributes no concept, so no rule is ever invented from damaged bytes.
 */

export interface GlossaryConcept {
  /** The glossary document, repository-relative. */
  path: string;
  boundedContext: string;
  /** The UbiLang concept id. */
  id: string;
  /** Every preferred label, in file order. */
  prefLabels: string[];
  /** Every alternative label, in file order. */
  altLabels: string[];
}

export interface Glossary {
  /** The glossary document, repository-relative. */
  path: string;
  boundedContext: string;
  concepts: GlossaryConcept[];
}

/** The normalized form every vocabulary comparison uses. */
export function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return undefined;
}

function labelsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const text = textOf(entry.text);
    if (text !== undefined) labels.push(text);
  }
  return labels;
}

/**
 * Every glossary document the repository publishes, repository-relative and
 * sorted. A symbolic link or a directory is never a glossary.
 */
export function glossaryPaths(
  repoDir: string,
  config: ConsistentNamingConfig = consistentNamingConfig(),
): string[] {
  const root = resolve(repoDir);
  const directory = join(root, config.glossaryDir);
  let names: string[];
  try {
    names = readdirSync(directory).sort();
  } catch {
    return [];
  }
  const paths: string[] = [];
  for (const name of names) {
    if (!name.endsWith(GLOSSARY_SUFFIX)) continue;
    const relative = `${config.glossaryDir}/${name}`;
    try {
      const stat = lstatSync(join(root, relative));
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    paths.push(relative);
  }
  return paths;
}

/** Parses one glossary document; a damaged document contributes no concept. */
export function parseGlossaryText(
  text: string,
  path: string,
): Glossary | undefined {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const context = textOf(parsed.boundedContext);
  if (context === undefined) return undefined;
  if (!Array.isArray(parsed.concepts)) return undefined;
  const concepts: GlossaryConcept[] = [];
  for (const entry of parsed.concepts) {
    if (!isRecord(entry)) continue;
    const id = textOf(entry.id);
    if (id === undefined) continue;
    const prefLabels = labelsOf(entry.prefLabels);
    if (prefLabels.length === 0) continue;
    concepts.push({
      path,
      boundedContext: context,
      id,
      prefLabels,
      altLabels: labelsOf(entry.altLabels),
    });
  }
  return { path, boundedContext: context, concepts };
}

/** Every readable published glossary, in path order. */
export function readGlossaries(
  repoDir: string,
  config: ConsistentNamingConfig = consistentNamingConfig(),
): Glossary[] {
  const root = resolve(repoDir);
  const glossaries: Glossary[] = [];
  for (const path of glossaryPaths(root, config)) {
    let text: string;
    try {
      text = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const glossary = parseGlossaryText(text, path);
    if (glossary !== undefined) glossaries.push(glossary);
  }
  return glossaries;
}

/** Every concept a glossary defines under this concept id or preferred label. */
export function conceptsDefinedAs(
  glossaries: readonly Glossary[],
  value: string,
): GlossaryConcept[] {
  const wanted = normalizeName(value);
  if (wanted.length === 0) return [];
  const matches: GlossaryConcept[] = [];
  for (const glossary of glossaries) {
    for (const concept of glossary.concepts) {
      if (
        normalizeName(concept.id) === wanted ||
        concept.prefLabels.some((label) => normalizeName(label) === wanted)
      ) {
        matches.push(concept);
      }
    }
  }
  return matches;
}

/** Every concept a glossary assigns this word to, as a preferred or alternative label. */
export function conceptsUsingTerm(
  glossaries: readonly Glossary[],
  value: string,
): GlossaryConcept[] {
  const wanted = normalizeName(value);
  if (wanted.length === 0) return [];
  const matches: GlossaryConcept[] = [];
  for (const glossary of glossaries) {
    for (const concept of glossary.concepts) {
      if (
        concept.prefLabels.some((label) => normalizeName(label) === wanted) ||
        concept.altLabels.some((label) => normalizeName(label) === wanted)
      ) {
        matches.push(concept);
      }
    }
  }
  return matches;
}

/** The concept's preferred label, preferring the English label first in file order. */
export function preferredLabel(concept: GlossaryConcept): string {
  return concept.prefLabels[0] ?? concept.id;
}

export { GLOSSARY_DIRECTORY, GLOSSARY_SUFFIX };
