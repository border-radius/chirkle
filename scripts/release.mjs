#!/usr/bin/env node
// `npm run release -- <version>`: give the npm package and the Android app the next version (docs/ANDROID.md §28.7).
// Sets package.json's version and the app's versionName, adds one to versionCode, and starts the store changelog for
// it. Then commit, push, and publish a GitHub Release with the new tag v<version>: release.yml does the rest.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const GRADLE = join(ROOT, "android/app/build.gradle.kts");
const RECIPE = join(ROOT, "android/fdroid/com.chirkle.android.yml");
const CHANGELOGS = join(ROOT, "fastlane/metadata/android/en-US/changelogs");

/** @param {string} message @returns {never} */
function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

/** @param {string} v */
const parts = (v) => v.split(".").map(Number);
/** @param {string} a @param {string} b */
const newer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

const version = process.argv[2]?.replace(/^v/, "");
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) fail("usage: npm run release -- <major.minor.patch>");

const pkg = JSON.parse(readFileSync(PKG, "utf8"));
let gradle = readFileSync(GRADLE, "utf8");
const codeMatch = gradle.match(/^( *versionCode = )(\d+)$/m);
const nameMatch = gradle.match(/^( *versionName = )"(.*)"$/m);
if (!codeMatch || !nameMatch) fail("versionCode/versionName not found in android/app/build.gradle.kts");
const oldName = nameMatch[2];
const oldPkg = pkg.version;
for (const [what, old] of [
  ["package.json", pkg.version],
  ["the app", oldName],
]) {
  if (!newer(version, old)) fail(`${version} is not newer than ${what}'s ${old}`);
}
const code = Number(codeMatch[2]) + 1;

// F-Droid parses both lines as literals: keep them that way.
gradle = gradle.replace(codeMatch[0], () => `${codeMatch[1]}${code}`).replace(nameMatch[0], () => `${nameMatch[1]}"${version}"`);
writeFileSync(GRADLE, gradle);
pkg.version = version;
writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`);

// The draft recipe lists only the latest build (§28.5).
let recipe = readFileSync(RECIPE, "utf8");
recipe = recipe
  .replace(/^( *- versionName: ).*$/m, (_, p) => `${p}${version}`)
  .replace(/^( *versionCode: ).*$/m, (_, p) => `${p}${code}`)
  .replace(/^( *commit: ).*$/m, (_, p) => `${p}v${version}`)
  .replace(/^CurrentVersion: .*$/m, () => `CurrentVersion: ${version}`)
  .replace(/^CurrentVersionCode: .*$/m, () => `CurrentVersionCode: ${code}`);
writeFileSync(RECIPE, recipe);

const changelog = join(CHANGELOGS, `${code}.txt`);
if (!existsSync(changelog)) writeFileSync(changelog, "Fixes.\n");

console.log(`npm package ${oldPkg} → ${version}, app ${oldName} → ${version} (versionCode ${code}).
Next:
  1. Write the app's release notes in fastlane/metadata/android/en-US/changelogs/${code}.txt (500 characters at most).
  2. Commit and push.
  3. On GitHub: Releases → Draft a new release → tag v${version} (create it on publish) → Publish.
     The Release workflow attaches the APK and stages chirkle@${version} on npm.
  4. Approve the staged package on npmjs.com (or: npm stage approve <id>).`);
