import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { chmod, cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mongoVersion = process.env.MONGO_VERSION ?? "8.0.17";
const mongoshVersion = process.env.MONGOSH_VERSION ?? "2.8.2";
const targetPlatform = process.env.TARGET_PLATFORM ?? process.platform;

const targets = {
  win32: {
    archiveType: "zip",
    serverAsset: `mongodb-windows-x86_64-${mongoVersion}.zip`,
    serverUrl: `https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-${mongoVersion}.zip`,
    shellAsset: `mongosh-${mongoshVersion}-win32-x64.zip`,
    shellUrl: `https://downloads.mongodb.com/compass/mongosh-${mongoshVersion}-win32-x64.zip`,
    mongod: "bin/mongod.exe",
    mongosh: "bin/mongosh.exe",
  },
  linux: {
    archiveType: "tar.gz",
    serverAsset: `mongodb-linux-x86_64-ubuntu2204-${mongoVersion}.tgz`,
    serverUrl: `https://fastdl.mongodb.org/linux/mongodb-linux-x86_64-ubuntu2204-${mongoVersion}.tgz`,
    shellAsset: `mongosh-${mongoshVersion}-linux-x64.tgz`,
    shellUrl: `https://downloads.mongodb.com/compass/mongosh-${mongoshVersion}-linux-x64.tgz`,
    mongod: "bin/mongod",
    mongosh: "bin/mongosh",
  },
  darwin: {
    archiveType: "tar.gz",
    serverAsset: `mongodb-macos-x86_64-${mongoVersion}.tgz`,
    serverUrl: `https://fastdl.mongodb.org/osx/mongodb-macos-x86_64-${mongoVersion}.tgz`,
    shellAsset: `mongosh-${mongoshVersion}-darwin-x64.zip`,
    shellUrl: `https://downloads.mongodb.com/compass/mongosh-${mongoshVersion}-darwin-x64.zip`,
    mongod: "bin/mongod",
    mongosh: "bin/mongosh",
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    shell: false,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function assetName(version, shellVersion, platform, archiveType) {
  return `lasso-mongo-${version}-mongosh-${shellVersion}-${platform}.${archiveType === "zip" ? "zip" : "tar.gz"}`;
}

async function download(url, destination) {
  if (existsSync(destination)) {
    return;
  }

  const response = await fetch(url, {
    headers: {
      "user-agent": "service-lasso-lasso-mongo-packager",
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(destination));
}

async function findRootWith(root, relativePath) {
  const queue = [root];

  while (queue.length > 0) {
    const current = queue.shift();
    if (existsSync(path.join(current, relativePath))) {
      return current;
    }

    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      }
    }
  }

  throw new Error(`Could not find ${relativePath} under ${root}.`);
}

async function copyBin(sourceRoot, packageRoot) {
  await cp(path.join(sourceRoot, "bin"), path.join(packageRoot, "bin"), {
    recursive: true,
    force: true,
  });
}

async function compressPackage(packageRoot, outputPath, archiveType) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await rm(outputPath, { force: true });

  if (archiveType === "zip") {
    run("powershell", [
      "-NoLogo",
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path ${JSON.stringify(path.join(packageRoot, "*"))} -DestinationPath ${JSON.stringify(outputPath)} -Force`,
    ]);
    return outputPath;
  }

  run("tar", ["-czf", outputPath, "-C", packageRoot, "."]);
  return outputPath;
}

export async function packageMongo(platform = targetPlatform, version = mongoVersion, shellVersion = mongoshVersion) {
  const target = targets[platform];
  if (!target) {
    throw new Error(`Unsupported target platform: ${platform}. Supported platforms: ${Object.keys(targets).join(", ")}.`);
  }

  const vendorRoot = path.join(repoRoot, "vendor", version, shellVersion, platform);
  const outputRoot = path.join(repoRoot, "output", "package", version, shellVersion, platform);
  const serverExtractRoot = path.join(outputRoot, "server");
  const shellExtractRoot = path.join(outputRoot, "shell");
  const packageRoot = path.join(outputRoot, "payload");
  const serverArchive = process.env.MONGO_VENDOR_ARCHIVE
    ? path.resolve(process.env.MONGO_VENDOR_ARCHIVE)
    : path.join(vendorRoot, target.serverAsset);
  const shellArchive = process.env.MONGOSH_VENDOR_ARCHIVE
    ? path.resolve(process.env.MONGOSH_VENDOR_ARCHIVE)
    : path.join(vendorRoot, target.shellAsset);
  const outputPath = path.join(repoRoot, "dist", assetName(version, shellVersion, platform, target.archiveType));

  await mkdir(vendorRoot, { recursive: true });
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(serverExtractRoot, { recursive: true });
  await mkdir(shellExtractRoot, { recursive: true });
  await mkdir(packageRoot, { recursive: true });

  if (!process.env.MONGO_VENDOR_ARCHIVE) {
    await download(target.serverUrl, serverArchive);
  }
  if (!process.env.MONGOSH_VENDOR_ARCHIVE) {
    await download(target.shellUrl, shellArchive);
  }

  run("tar", ["-xf", serverArchive, "-C", serverExtractRoot]);
  run("tar", ["-xf", shellArchive, "-C", shellExtractRoot]);

  const serverRoot = await findRootWith(serverExtractRoot, target.mongod);
  const shellRoot = await findRootWith(shellExtractRoot, target.mongosh);
  await copyBin(serverRoot, packageRoot);
  await copyBin(shellRoot, packageRoot);
  await writeFile(path.join(packageRoot, "lasso-mongo.mjs"), launcherSource, "utf8");

  if (platform !== "win32") {
    await chmod(path.join(packageRoot, "bin", "mongod"), 0o755);
    await chmod(path.join(packageRoot, "bin", "mongosh"), 0o755);
    await chmod(path.join(packageRoot, "lasso-mongo.mjs"), 0o755);
  }

  const packageStats = await stat(path.join(packageRoot, target.mongod));
  if (!packageStats.isFile() || !existsSync(path.join(packageRoot, target.mongosh))) {
    throw new Error("Packaged MongoDB payload is missing mongod or mongosh.");
  }

  await writeFile(
    path.join(packageRoot, "SERVICE-LASSO-PACKAGE.json"),
    `${JSON.stringify(
      {
        serviceId: "mongo",
        upstream: {
          vendor: "MongoDB",
          server: {
            product: "MongoDB Community Server",
            version,
            asset: target.serverAsset,
            url: target.serverUrl,
          },
          shell: {
            product: "MongoDB Shell",
            version: shellVersion,
            asset: target.shellAsset,
            url: target.shellUrl,
          },
        },
        packagedBy: "service-lasso/lasso-mongo",
        platform,
        arch: "x64",
        command: "node ./lasso-mongo.mjs",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await compressPackage(packageRoot, outputPath, target.archiveType);
  console.log(`[lasso-mongo] packaged ${outputPath}`);
  return outputPath;
}

const launcherSource = String.raw`import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";
const binRoot = path.join(packageRoot, "bin");
const serviceRoot = process.env.SERVICE_ROOT ?? process.cwd();
const runtimeRoot = path.join(serviceRoot, "runtime");
const dataRoot = process.env.MONGO_DATA_DIR ?? path.join(runtimeRoot, "data");
const initializedMarker = path.join(runtimeRoot, "mongo.initialized");
const host = process.env.MONGO_HOST ?? "127.0.0.1";
const bindIp = process.env.MONGO_BIND_IP ?? host;
const port = process.env.MONGO_PORT ?? process.env.SERVICE_PORT ?? "8180";
const username = process.env.MONGO_USERNAME ?? "mongoadmin";
const password = process.env.MONGO_PASSWORD ?? "mongoadmin";
const env = {
  ...process.env,
  PATH: binRoot + path.delimiter + (process.env.PATH ?? ""),
  MONGOSH_DISABLE_TELEMETRY: "1",
};
let mongod = null;
let stopping = false;
let expectedMongodStop = false;
let mongodPort = port;

function exe(name) {
  return path.join(binRoot, isWindows ? name + ".exe" : name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env,
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(command + " " + args.join(" ") + " failed with exit code " + result.status);
  }
}

async function waitForTcp(listenPort = port, timeoutMs = 60_000) {
  const net = await import("node:net");
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: Number(listenPort) });
        socket.once("connect", () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw lastError ?? new Error("Timed out waiting for MongoDB.");
}

async function reserveLoopbackPort() {
  const net = await import("node:net");
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve MongoDB bootstrap port.")));
        return;
      }
      server.close(() => resolve(String(address.port)));
    });
  });
}

function mongoUrl(listenPort, authenticated) {
  const credentials = authenticated
    ? encodeURIComponent(username) + ":" + encodeURIComponent(password) + "@"
    : "";
  return "mongodb://" + credentials + host + ":" + listenPort + "/admin";
}

function requestMongodShutdown({ listenPort, authenticated }) {
  spawnSync(exe("mongosh"), [
    mongoUrl(listenPort, authenticated),
    "--quiet",
    "--eval",
    "db.adminCommand({shutdown: 1, force: true})",
  ], {
    stdio: "ignore",
    env,
  });
}

function startMongod({ auth, listenPort = port }) {
  mongodPort = listenPort;
  mongod = spawn(exe("mongod"), [
    "--dbpath",
    dataRoot,
    "--bind_ip",
    bindIp,
    "--port",
    listenPort,
    ...(auth ? ["--auth"] : []),
  ], {
    stdio: "inherit",
    env,
  });

  mongod.on("exit", (code) => {
    if (!stopping && !expectedMongodStop) {
      process.exit(code ?? 1);
    }
  });
}

async function stopMongod({ listenPort = mongodPort, authenticated = false } = {}) {
  if (!mongod || mongod.exitCode !== null || mongod.signalCode !== null) {
    return;
  }

  expectedMongodStop = true;
  requestMongodShutdown({ listenPort, authenticated });
  await Promise.race([
    new Promise((resolve) => mongod.once("close", resolve)),
    sleep(10_000).then(() => {
      if (mongod && mongod.exitCode === null && mongod.signalCode === null) {
        mongod.kill("SIGTERM");
      }
    }),
  ]);
  expectedMongodStop = false;
  mongod = null;
}

async function stop() {
  if (stopping) {
    return;
  }

  stopping = true;
  await stopMongod({ authenticated: true });
  process.exit(0);
}

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

async function initializeIfNeeded() {
  if (existsSync(initializedMarker)) {
    return;
  }

  const bootstrapPort = await reserveLoopbackPort();
  startMongod({ auth: false, listenPort: bootstrapPort });
  await waitForTcp(bootstrapPort);
  try {
    run(exe("mongosh"), [
      mongoUrl(bootstrapPort, false),
      "--quiet",
      "--eval",
      "db.getSiblingDB('admin').createUser({user: " + JSON.stringify(username) + ", pwd: " + JSON.stringify(password) + ", roles: [{role: 'root', db: 'admin'}]}); if (!db.getSiblingDB('admin').getUser(" + JSON.stringify(username) + ")) { throw new Error('MongoDB bootstrap user was not created'); }",
    ]);
    writeFileSync(initializedMarker, new Date().toISOString() + "\n", "utf8");
  } finally {
    await stopMongod({ listenPort: bootstrapPort, authenticated: false });
  }
}

mkdirSync(runtimeRoot, { recursive: true });
mkdirSync(dataRoot, { recursive: true });

await initializeIfNeeded();
startMongod({ auth: true });
`;

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await packageMongo();
}
