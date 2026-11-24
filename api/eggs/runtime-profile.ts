import { parseEgg } from "./codec";
import { lifecycleFixture } from "../wings/lifecycle-fixture";

// Called only after exact-document approval. This is not a script sandbox.
export function compileReviewedProfile(
  document: string,
  installed: Parameters<typeof lifecycleFixture>[0],
  server: Parameters<typeof lifecycleFixture>[1],
  overrides: Readonly<Record<string, string>>,
  resources: { memory_limit: number; disk_space: number },
) {
  const decoded = parseEgg(document);
  const egg = JSON.parse(document) as {
    startup: string;
    config: { files: string; startup: string; stop: string };
    variables: { env_variable: string; default_value: string; rules: string }[];
    scripts: {
      installation: { script: string; entrypoint: string; container: string };
    };
  };
  const unsupported = (field: string): never => {
    throw new Error(`Unsupported reviewed egg ${field}`);
  };
  const base = lifecycleFixture(installed, server);
  const environment: Record<string, string> = {
    ...(base.configuration.settings.environment as Record<string, string>),
  };
  const remaining = new Set(Object.keys(overrides));
  for (const variable of egg.variables) {
    const name = variable.env_variable;
    if (Object.hasOwn(environment, name) || typeof variable.rules !== "string")
      unsupported(name);
    const value = overrides[name] ?? variable.default_value;
    remaining.delete(name);
    if (typeof value !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(value))
      unsupported(name);
    for (const rule of variable.rules.split("|")) {
      if (rule === "required" || rule === "string") continue;
      if (rule === "numeric" || rule === "integer") {
        if (!/^\d+$/.test(value)) unsupported(name);
      } else if (rule.startsWith("in:")) {
        if (!rule.slice(3).split(",").includes(value)) unsupported(name);
      } else if (/^max:\d+$/.test(rule)) {
        if (value.length > Number(rule.slice(4))) unsupported(name);
      } else if (/^(between|digits_between):\d+,\d+$/.test(rule)) {
        const [min, max] = rule.split(":")[1].split(",").map(Number);
        const candidate = rule.startsWith("digits_")
          ? value.length
          : Number(value);
        if (!/^\d+$/.test(value) || candidate < min || candidate > max)
          unsupported(name);
      } else unsupported(`rule ${rule}`);
    }
    environment[name] = value;
  }
  if (remaining.size) unsupported("override");
  const render = (template: string) => {
    const value = template.replace(
      /\{\{server\.build\.(default\.port|env\.([A-Z0-9_]+))\}\}/g,
      (_match: string, field: string, key?: string) =>
        field === "default.port"
          ? environment.SERVER_PORT
          : key && Object.hasOwn(environment, key)
            ? environment[key]
            : unsupported("placeholder"),
    );
    if (value.includes("{{") || value.includes("}}"))
      unsupported("placeholder");
    return value;
  };
  const files = JSON.parse(egg.config.files) as Record<
    string,
    { parser: string; find: Record<string, string> }
  >;
  const configs = Object.entries(files).map(([file, { parser, find }]) => {
    if (
      !/^[A-Za-z0-9_./-]+$/.test(file) ||
      file.split("/").some((part) => !part || part === "." || part === "..") ||
      !["ini", "file", "json", "properties"].includes(parser)
    )
      unsupported("configuration mapping");
    return {
      file,
      parser,
      replace: Object.entries(find).map(([match, value]) => ({
        match,
        replace_with: render(value),
      })),
    };
  });
  const images = Object.values(decoded.images);
  const done = JSON.parse(egg.config.startup).done;
  const signal: Record<string, string> = {
    "^C": "SIGINT",
    "^^C": "SIGINT",
    "^SIGTERM": "SIGTERM",
  };
  if (
    images.length !== 1 ||
    typeof done !== "string" ||
    !done ||
    !Object.hasOwn(signal, egg.config.stop)
  )
    unsupported("image or process settings");
  return {
    ...base,
    configuration: {
      settings: {
        ...base.configuration.settings,
        environment,
        invocation: egg.startup,
        container: { image: images[0], requires_rebuild: false },
        build: {
          ...(base.configuration.settings.build as Record<string, unknown>),
          ...resources,
        },
      },
      process_configuration: {
        ...base.configuration.process_configuration,
        startup: { done: [done], user_interaction: [], strip_ansi: false },
        stop: { type: "signal", value: signal[egg.config.stop] },
        configs,
      },
    },
    install: {
      script: egg.scripts.installation.script,
      entrypoint: egg.scripts.installation.entrypoint,
      container_image: egg.scripts.installation.container,
    },
  };
}
