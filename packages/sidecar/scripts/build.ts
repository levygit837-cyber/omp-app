/**
 * Compiles the sidecar to one self-contained executable: `dist/omp-app-sidecar`.
 *
 * The native addon is embedded the way omp embeds it for its own binary
 * (`packages/natives/scripts/embed-native.ts`): the addon is zstd-compressed and handed to
 * `Bun.build` in memory, together with a replacement for the null `native/embedded-addon.js`
 * manifest. At first start the omp loader (`loader-state.js`) extracts it to
 * `~/.omp/natives/<omp version>/` and loads it from there. The binary needs no system Bun,
 * no node_modules and no files next to it.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

const platform = process.platform;
const arch = process.arch;
if (platform !== "darwin" || arch !== "arm64") {
  throw new Error(`only darwin-arm64 is supported for now, got ${platform}-${arch}`);
}
const platformTag = `${platform}-${arch}`;
const target = "bun-darwin-arm64";

const root = join(import.meta.dir, "..");
const outfile = join(root, "dist", "omp-app-sidecar");

/** Root of an installed package, found by walking up from its resolved entry point. */
function packageRoot(name: string, from: string): { dir: string; version: string } {
  let dir = dirname(Bun.fileURLToPath(import.meta.resolve(name, from)));
  while (true) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string; version: string };
      if (pkg.name === name) return { dir, version: pkg.version };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find package root of ${name}`);
    dir = parent;
  }
}

const natives = packageRoot("@oh-my-pi/pi-natives", join(root, "package.json"));
const nativeDir = realpathSync(join(natives.dir, "native"));

// The addon ships in the platform leaf package, a dependency of pi-natives.
const leaf = packageRoot(`@oh-my-pi/pi-natives-${platformTag}`, join(natives.dir, "package.json"));
const filename = `pi_natives.${platformTag}.node`;
if (leaf.version !== natives.version) {
  throw new Error(`addon package ${leaf.version} does not match pi-natives ${natives.version}`);
}
const addon = await Bun.file(join(leaf.dir, filename)).bytes();
const frame = await Bun.zstdCompress(addon, { level: 19 });

const manifest = `import zstdPath0 from ${JSON.stringify(`./${filename}.zst`)} with { type: "file" };
export const embeddedAddon = {
  platformTag: ${JSON.stringify(platformTag)},
  version: ${JSON.stringify(natives.version)},
  files: [{ variant: "default", filename: ${JSON.stringify(filename)}, size: ${addon.length}, zstdPath: zstdPath0 }],
};
`;

/**
 * omp's own build supplies `omp-legacy-pi-modules`, a registry that lets legacy Pi extensions
 * import the bundled `pi-*` packages (scripts/legacy-pi-virtual-module.ts in omp). omp only
 * imports it, lazily, when it loads such an extension. This sidecar loads no extensions yet,
 * so the registry is empty: a lookup fails with omp's "no bundled module registered" error
 * instead of silently misbehaving. Revisit when the app starts loading extensions.
 */
const legacyPiModulesStub: Bun.BunPlugin = {
  name: "omp-app:legacy-pi-modules-stub",
  setup(build) {
    build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
      path: "omp-legacy-pi-modules",
      namespace: "omp-app-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "omp-app-stub" }, () => ({
      contents: "export const BUNDLED_PI_MODULE_LOADERS = {};",
      loader: "js",
    }));
  },
};

mkdirSync(dirname(outfile), { recursive: true });
// Bun signs the output itself, but the embedded-addon build edits it afterwards and the
// signature goes stale: macOS then SIGKILLs the binary on launch. Like omp's own build
// (coding-agent/scripts/build-binary.ts), skip Bun's signing and sign ad hoc with entitlements.
Bun.env.BUN_NO_CODESIGN_MACHO_BINARY = "1";
const result = await Bun.build({
  entrypoints: [join(root, "src", "main.ts")],
  // Override keys must equal the bundler's symlink-resolved module paths.
  files: {
    [join(nativeDir, `${filename}.zst`)]: frame,
    [join(nativeDir, "embedded-addon.js")]: manifest,
  },
  target: "bun",
  format: "esm",
  plugins: [legacyPiModulesStub],
  compile: {
    target,
    outfile,
    autoloadBunfig: false,
    autoloadDotenv: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  throw: false,
});
if (!result.success) {
  throw new Error(`sidecar build failed:\n${result.logs.map((l) => l.message).join("\n")}`);
}
// `bun build --compile` can leave its temp executable (`.<hash>.bun-build`, ~60 MB) in the cwd.
for (const name of readdirSync(process.cwd())) {
  if (/^\..*\.bun-build$/.test(name)) rmSync(join(process.cwd(), name), { force: true });
}
chmodSync(outfile, 0o755);
const sign = Bun.spawnSync(
  [
    "codesign",
    "--force",
    "--sign",
    "-",
    "--entitlements",
    join(root, "entitlements.plist"),
    outfile,
  ],
  { stdout: "inherit", stderr: "inherit" },
);
if (sign.exitCode !== 0) throw new Error(`codesign failed with exit code ${sign.exitCode}`);
console.log(`built ${outfile} (omp natives ${natives.version}, ${platformTag})`);
