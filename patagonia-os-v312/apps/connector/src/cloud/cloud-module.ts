// Arma el canal con la nube para service.ts: cliente, credencial, huella, ejecutor y página /vincular.
// La dirección sale de config.json (cloud.url) o de la variable PATAGONIA_CLOUD_URL (la pone el instalador).

import type { CloudSettings } from "../config/config";
import { isValidCloudUrl } from "../config/config";
import type { Logger } from "../log/logger";
import type { LocalRoute } from "../server/local-server";
import { CloudAgent } from "./cloud-agent";
import { CloudClient, type SeenScale } from "./cloud-client";
import { createCredentialStore, type CredentialStore } from "./credential-store";
import { computeFingerprint } from "./fingerprint";
import { UnavailableExecutor, type JobExecutor } from "./job-executor";
import { createPairingRoute } from "./pairing-page";

export interface CloudModuleOverrides {
  fetch?: typeof fetch;
  store?: CredentialStore;
  executor?: JobExecutor;
  fingerprint?: () => Promise<string | null>;
  backoffMs?: readonly number[];
  minPollGapMs?: number;
  csrfToken?: string;
}

export interface CloudModuleOptions {
  settings: CloudSettings;
  credentialFile: string;
  env: Record<string, string | undefined>;
  version: string;
  logger: Logger;
  seenScales: () => SeenScale[];
  overrides?: CloudModuleOverrides;
}

export interface CloudModule {
  agent: CloudAgent;
  routes: LocalRoute[];
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): Record<string, unknown>;
}

export function resolveCloudUrl(settings: CloudSettings, env: Record<string, string | undefined>): string | null {
  const fromEnv = env.PATAGONIA_CLOUD_URL?.trim();
  if (fromEnv && isValidCloudUrl(fromEnv)) return fromEnv.replace(/\/+$/, "");
  return settings.url;
}

export function createCloudModule(options: CloudModuleOptions): CloudModule {
  const o = options.overrides ?? {};
  const url = resolveCloudUrl(options.settings, options.env);
  const client = url ? new CloudClient({ baseUrl: url, fetch: o.fetch, userAgent: `PatagoniaScaleConnect/${options.version}` }) : null;
  const agent = new CloudAgent({
    client,
    store: o.store ?? createCredentialStore(options.credentialFile),
    executor: o.executor ?? new UnavailableExecutor(),
    version: options.version,
    seenScales: options.seenScales,
    fingerprint: o.fingerprint ?? (() => computeFingerprint()),
    logger: options.logger,
    heartbeatMs: options.settings.heartbeatMs,
    pollWaitSec: options.settings.pollWaitSec,
    backoffMs: o.backoffMs,
    minPollGapMs: o.minPollGapMs,
  });
  return {
    agent,
    routes: [createPairingRoute({ agent, csrfToken: o.csrfToken })],
    start: () => agent.start(),
    stop: () => agent.stop(),
    status: () => ({ ...agent.status(), url }),
  };
}
