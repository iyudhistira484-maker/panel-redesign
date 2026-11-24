export type EggVersion = "PTDL_v1" | "PTDL_v2";
type JsonObject = Record<string, unknown>;
export type EggVariable = { env_variable: string; rules: string | string[] };
export type EggDocument = {
  version: EggVersion;
  name: string;
  images: Readonly<Record<string, string>>;
  variables: readonly EggVariable[];
  source: string;
};
export class EggFormatError extends Error {
  constructor(readonly field: string) {
    super(`Invalid egg field: ${field}`);
  }
}
function object(input: unknown, path: string): JsonObject {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new EggFormatError(path);
  return input as JsonObject;
}
function text(input: unknown, path: string): string {
  if (typeof input !== "string" || !input.trim())
    throw new EggFormatError(path);
  return input;
}
function nullableText(input: unknown, path: string) {
  if (input !== null && input !== undefined && typeof input !== "string")
    throw new EggFormatError(path);
}
function strings(input: unknown, path: string): string[] {
  if (!Array.isArray(input) || input.some((i) => typeof i !== "string"))
    throw new EggFormatError(path);
  return input;
}
export function parseEgg(source: string): EggDocument {
  if (Buffer.byteLength(source) > 1024 * 1024) throw new EggFormatError("size");
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new EggFormatError("json");
  }
  const egg = object(raw, "root");
  const meta = object(egg.meta, "meta");
  const version = meta.version;
  if (version !== "PTDL_v1" && version !== "PTDL_v2")
    throw new EggFormatError("meta.version");
  const name = text(egg.name, "name");
  nullableText(meta.update_url, "meta.update_url");
  nullableText(egg.author, "author");
  nullableText(egg.description, "description");
  nullableText(egg.startup, "startup");
  if (egg.features !== undefined && egg.features !== null)
    strings(egg.features, "features");
  if (egg.file_denylist !== undefined && egg.file_denylist !== null)
    strings(egg.file_denylist, "file_denylist");
  const config = object(egg.config, "config");
  for (const field of ["files", "startup", "logs"] as const) {
    const v = config[field];
    if (
      v !== undefined &&
      v !== null &&
      typeof v !== "string" &&
      typeof v !== "object"
    )
      throw new EggFormatError(`config.${field}`);
  }
  nullableText(config.stop, "config.stop");
  const script = object(
    object(egg.scripts, "scripts").installation,
    "scripts.installation",
  );
  for (const field of ["script", "container", "entrypoint"] as const)
    nullableText(script[field], `scripts.installation.${field}`);
  const v1Images = () =>
    Array.isArray(egg.images)
      ? strings(egg.images, "images")
      : egg.image == null
        ? []
        : [text(egg.image, "image")];
  const imageEntries =
    version === "PTDL_v1"
      ? v1Images().map((image) => [image, image])
      : Object.entries(object(egg.docker_images, "docker_images"));
  if (!imageEntries.length) throw new EggFormatError("images");
  const images = Object.fromEntries(
    imageEntries.map(([label, value]) => [
      text(label, "image label"),
      text(value, "image reference"),
    ]),
  );
  const seen = new Set<string>();
  const rawVariables = egg.variables ?? [];
  if (!Array.isArray(rawVariables)) throw new EggFormatError("variables");
  const variables = rawVariables.map((value, index) => {
    const variable = object(value, `variables.${index}`);
    const key = text(variable.env_variable, "variables.env_variable");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || seen.has(key))
      throw new EggFormatError("variables.env_variable");
    seen.add(key);
    const rules =
      typeof variable.rules === "string"
        ? variable.rules
        : strings(variable.rules, "variables.rules");
    return { env_variable: key, rules };
  });
  return { version, name, images, variables, source };
}
export function exportEgg(
  egg: EggDocument,
  target: EggVersion = egg.version,
): string {
  const validated = parseEgg(egg.source);
  if (target === validated.version) return validated.source;
  const raw = object(JSON.parse(validated.source), "root");
  const meta = object(raw.meta, "meta");
  const base = { ...raw };
  for (const key of ["image", "images", "docker_images"]) delete base[key];
  if (target === "PTDL_v2")
    return JSON.stringify(
      {
        ...base,
        meta: { ...meta, version: target },
        docker_images: validated.images,
      },
      null,
      2,
    );
  const entries = Object.entries(validated.images);
  if (entries.some(([label, reference]) => label !== reference))
    throw new EggFormatError("docker_images: PTDL_v1 would lose image labels");
  return JSON.stringify(
    {
      ...base,
      meta: { ...meta, version: target },
      images: entries.map(([, reference]) => reference),
    },
    null,
    2,
  );
}
