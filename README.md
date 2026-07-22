# lasso-mongo

Release-backed MongoDB Community Server package for Service Lasso.

This repo publishes MongoDB as an app-owned data service. Consumers add the released `service.json` to their own `services/mongo/service.json` when they need a local MongoDB instance.

## What It Packages

- MongoDB Community Server `8.0.17`
- MongoDB Shell `mongosh` `2.8.2`
- A small Node launcher, `lasso-mongo.mjs`, that initializes the data directory, creates the root user on first run, starts `mongod`, and handles shutdown

Release artifacts are named with the upstream versions:

- `lasso-mongo-8.0.17-mongosh-2.8.2-win32.zip`
- `lasso-mongo-8.0.17-mongosh-2.8.2-linux.tar.gz`
- `lasso-mongo-8.0.17-mongosh-2.8.2-darwin.tar.gz`
- `service.json`
- `SHA256SUMS.txt`

## Defaults

- Service id: `mongo`
- Port: `8180`
- Host: `127.0.0.1`
- Root user: `mongoadmin`
- Root password: `mongoadmin`
- Data path: `${SERVICE_ROOT}/runtime/data`
- Healthchecks: `mongo-tcp-ready` TCP `${MONGO_HOST}:${MONGO_PORT}`

The manifest exports `MONGO_HOST`, `MONGO_PORT`, `MONGO_USERNAME`, `MONGO_PASSWORD`, and `MONGO_HOME` through `globalenv`.

## Local Verification

```powershell
npm test
```

The verifier packages the current platform, extracts the artifact, starts MongoDB through the packaged launcher, proves authenticated `mongosh` ping, and stops the service.

## Notes

MongoDB is intentionally not a Service Lasso baseline service. It is app-owned because database names, credentials, data retention, and migration policy belong to the consuming application.
