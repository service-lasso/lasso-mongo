import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageMongo } from "./package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const platform = process.env.TARGET_PLATFORM ?? process.platform;
const mongoVersion = process.env.MONGO_VERSION ?? "8.0.17";
const mongoshVersion = process.env.MONGOSH_VERSION ?? "2.8.2";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve loopback port.")));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForTcp(port, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
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

  throw lastError ?? new Error(`Timed out waiting for MongoDB on ${port}.`);
}

async function waitForMongosh(mongosh, port, timeoutMs = 60_000) {
  const startedAt = Date.now();
  let lastResult = null;

  while (Date.now() - startedAt < timeoutMs) {
    const result = spawnSync(
      mongosh,
      [
        `mongodb://mongoadmin:mongoadmin@127.0.0.1:${port}/admin`,
        "--quiet",
        "--eval",
        "db.runCommand({ ping: 1 }).ok",
      ],
      {
        env: {
          ...process.env,
          MONGOSH_DISABLE_TELEMETRY: "1",
          PATH: `${path.dirname(mongosh)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        shell: false,
      },
    );

    if (result.status === 0 && result.stdout.trim().endsWith("1")) {
      process.stdout.write(result.stdout);
      return;
    }

    lastResult = result;
    await sleep(500);
  }

  throw new Error(
    `Timed out waiting for mongosh verification. Last exit code: ${lastResult?.status ?? "unknown"}; stderr: ${lastResult?.stderr ?? ""}`,
  );
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    sleep(10_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

const artifact = await packageMongo(platform, mongoVersion, mongoshVersion);
const verifyRoot = path.join(repoRoot, "output", "verify", mongoVersion, mongoshVersion, platform);
const serviceRoot = path.join(verifyRoot, "service");
const extractRoot = path.join(serviceRoot, ".state", "extracted", "current");
const serviceManifest = JSON.parse(await readFile(path.join(repoRoot, "service.json"), "utf8"));
const metadataPath = path.join(extractRoot, "SERVICE-LASSO-PACKAGE.json");
const tcpPort = await reserveLoopbackPort();
const dataRoot = path.join(serviceRoot, "runtime", "data");

if (serviceManifest.id !== "mongo" || serviceManifest.version !== mongoVersion) {
  throw new Error(`Unexpected service manifest identity: ${JSON.stringify({ id: serviceManifest.id, version: serviceManifest.version })}`);
}

const legacyHealthField = ["health", "check"].join("");
if (legacyHealthField in serviceManifest) {
  throw new Error(`MongoDB service.json must use canonical healthchecks[] instead of the legacy single-check field: ${JSON.stringify(serviceManifest[legacyHealthField])}`);
}

const [mongoReadyCheck] = serviceManifest.healthchecks ?? [];
if (
  serviceManifest.healthchecks?.length !== 1 ||
  mongoReadyCheck?.id !== "mongo-tcp-ready" ||
  mongoReadyCheck.type !== "tcp" ||
  serviceManifest.ports?.service !== 8180
) {
  throw new Error(`MongoDB service.json health/ports drifted: ${JSON.stringify(serviceManifest)}`);
}
if (mongoReadyCheck.address !== "${MONGO_HOST}:${MONGO_PORT}") {
  throw new Error(`MongoDB service.json must expose TCP ready-check address from MONGO env: ${JSON.stringify(mongoReadyCheck)}`);
}

for (const key of ["MONGO_HOST", "MONGO_PORT", "MONGO_USERNAME", "MONGO_PASSWORD", "MONGO_HOME"]) {
  if (!serviceManifest.globalenv?.[key] && !serviceManifest.env?.[key]) {
    throw new Error(`MongoDB service.json is missing env/globalenv ${key}.`);
  }
}

await rm(verifyRoot, { recursive: true, force: true });
await mkdir(extractRoot, { recursive: true });
run("tar", ["-xf", artifact, "-C", extractRoot]);

const packageMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
if (
  packageMetadata.serviceId !== "mongo" ||
  packageMetadata.upstream?.server?.version !== mongoVersion ||
  packageMetadata.upstream?.shell?.version !== mongoshVersion ||
  packageMetadata.packagedBy !== "service-lasso/lasso-mongo" ||
  packageMetadata.platform !== platform
) {
  throw new Error(`Unexpected package metadata: ${JSON.stringify(packageMetadata)}`);
}

const mongo = spawn(process.execPath, ["./lasso-mongo.mjs"], {
  cwd: extractRoot,
  env: {
    ...process.env,
    SERVICE_ROOT: serviceRoot,
    SERVICE_PORT: String(tcpPort),
    MONGO_HOST: "127.0.0.1",
    MONGO_BIND_IP: "127.0.0.1",
    MONGO_PORT: String(tcpPort),
    MONGO_USERNAME: "mongoadmin",
    MONGO_PASSWORD: "mongoadmin",
    MONGO_DATA_DIR: dataRoot,
    MONGOSH_DISABLE_TELEMETRY: "1",
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});

let stdout = "";
let stderr = "";
mongo.stdout?.on("data", (chunk) => {
  stdout += chunk.toString();
});
mongo.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForTcp(tcpPort);
  const mongosh = path.join(extractRoot, "bin", platform === "win32" ? "mongosh.exe" : "mongosh");
  await waitForMongosh(mongosh, tcpPort);
  console.log("[lasso-mongo] verification passed");
} catch (error) {
  console.error("[lasso-mongo] stdout:");
  console.error(stdout);
  console.error("[lasso-mongo] stderr:");
  console.error(stderr);
  throw error;
} finally {
  await stopChild(mongo);
}
