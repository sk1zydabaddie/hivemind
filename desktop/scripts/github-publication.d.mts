export interface ReleaseChannel {
  schema_version: number;
  kind: string;
  repository: string;
  branch: string;
  api_origin: string;
  remote_url: string;
}

export function validateReleaseChannel(channel: ReleaseChannel): ReleaseChannel;
export function validateReleaseEnvironment(environment: NodeJS.ProcessEnv, channel: ReleaseChannel, sourceCommit: string): string;
export function validateWorkflowEnvelope(environment: NodeJS.ProcessEnv): void;
export function assertCurrentReleaseSource(sourceCommit: string, channel: ReleaseChannel, runGit: (args: string[]) => string): void;
export function createGitHubApi(options: { channel: ReleaseChannel; token: string; fetchImpl?: typeof fetch }): Record<string, (...args: any[]) => any>;
export function publishDraftTransaction(options: {
  api: any;
  manifest: Record<string, any>;
  assets: Array<{ role: string; name: string; contentType: string; bytes: Buffer }>;
  buildDescriptor: (uploaded: Map<string, any>) => Record<string, unknown>;
  verifyDraft: (candidateUrl: string) => Promise<void>;
}): Promise<{ release_id: number; tag_name: string; artifact_id: string }>;
