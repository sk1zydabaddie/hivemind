import { describe, expect, test, vi } from "vitest";
import {
  assertCurrentReleaseSource,
  buildReleasePresentation,
  canonicalGitHubAssetUrl,
  publishDraftTransaction,
  validateReleaseChannel,
  validateReleaseEnvironment,
  validateWorkflowEnvelope
} from "../scripts/github-publication.mjs";
import { UNSIGNED_BETA_INSTALL_NOTICE } from "../scripts/release-verification.mjs";

const manifest = {
  version: "416.1.2",
  artifact_id: "a".repeat(64),
  source_commit: "b".repeat(40),
  installer: { sha256: "c".repeat(64) }
};
const presentation = buildReleasePresentation(manifest, { releaseTier: "production" });
const assets = [
  { role: "installer", name: "setup.exe", contentType: "application/octet-stream", bytes: Buffer.from("installer") },
  { role: "updater", name: "latest.json", contentType: "application/json", bytes: Buffer.from("{}") }
];

describe("GitHub draft publication", () => {
  test("verifies the complete draft before making exactly that release public", async () => {
    const fixture = fakeApi();
    const verifyDraft = vi.fn(async () => {
      expect(fixture.state.release.draft).toBe(true);
      expect(fixture.state.events).not.toContain("publish");
    });
    const result = await publishDraftTransaction({
      api: fixture.api,
      manifest,
      assets,
      presentation,
      buildDescriptor: descriptor,
      verifyDraft
    });
    expect(result).toEqual({ release_id: 42, tag_name: "v416.1.2", artifact_id: manifest.artifact_id });
    expect(verifyDraft).toHaveBeenCalledOnce();
    expect(fixture.state.release.draft).toBe(false);
    expect(fixture.state.events).toEqual([
      "list", "tag", "draft", "upload:setup.exe", "upload:latest.json",
      "upload:release-candidate.json", "get", "publish", "get", "latest"
    ]);
  });

  test("an upload failure deletes the draft and never publishes", async () => {
    const fixture = fakeApi({ failUpload: "latest.json" });
    await expect(publishDraftTransaction({
      api: fixture.api,
      manifest,
      assets,
      presentation,
      buildDescriptor: descriptor,
      verifyDraft: async () => undefined
    })).rejects.toThrow(/upload failed/u);
    expect(fixture.state.events).toContain("delete");
    expect(fixture.state.events).not.toContain("publish");
    expect(fixture.state.deleted).toBe(true);
  });

  test("a failed byte/signature verification deletes the still-private draft", async () => {
    const fixture = fakeApi();
    await expect(publishDraftTransaction({
      api: fixture.api,
      manifest,
      assets,
      presentation,
      buildDescriptor: descriptor,
      verifyDraft: async () => { throw new Error("candidate bytes differ"); }
    })).rejects.toThrow("candidate bytes differ");
    expect(fixture.state.events).toContain("delete");
    expect(fixture.state.events).not.toContain("publish");
  });

  test("an ambiguous publish response withdraws the observed public release", async () => {
    const fixture = fakeApi({ ambiguousPublish: true });
    await expect(publishDraftTransaction({
      api: fixture.api,
      manifest,
      assets,
      presentation,
      buildDescriptor: descriptor,
      verifyDraft: async () => undefined
    })).rejects.toThrow(/connection lost after publish/u);
    expect(fixture.state.events).toContain("publish");
    expect(fixture.state.events).toContain("withdraw");
    expect(fixture.state.release.draft).toBe(true);
  });

  test("a public candidate that is not latest is withdrawn", async () => {
    const fixture = fakeApi({ latestMismatch: true });
    await expect(publishDraftTransaction({
      api: fixture.api,
      manifest,
      assets,
      presentation,
      buildDescriptor: descriptor,
      verifyDraft: async () => undefined
    })).rejects.toThrow(/latest release is not/u);
    expect(fixture.state.events).toContain("latest");
    expect(fixture.state.events).toContain("withdraw");
    expect(fixture.state.release.draft).toBe(true);
  });

  test("a public tag or a foreign draft is never reused", async () => {
    const published = fakeApi({ existing: { id: 8, draft: false, tag_name: "v416.1.2", target_commitish: manifest.source_commit } });
    await expect(publishDraftTransaction({ api: published.api, manifest, assets, presentation, buildDescriptor: descriptor, verifyDraft: async () => undefined }))
      .rejects.toThrow(/already public/u);
    const foreign = fakeApi({ existing: { id: 9, draft: true, tag_name: "v416.1.2", target_commitish: "c".repeat(40) } });
    await expect(publishDraftTransaction({ api: foreign.api, manifest, assets, presentation, buildDescriptor: descriptor, verifyDraft: async () => undefined }))
      .rejects.toThrow(/another source commit/u);
  });

  test("only the protected manual workflow for the exact repository branch and commit is admitted", () => {
    const channel = validateReleaseChannel({
      schema_version: 1,
      kind: "hivemind-github-release-channel",
      repository: "owner/repo",
      branch: "master",
      api_origin: "https://api.github.com",
      remote_url: "https://github.com/owner/repo.git"
    });
    const environment = {
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      HIVEMIND_PUBLIC_RELEASE_APPROVED: "true",
      HIVEMIND_RELEASE_TIER: "production",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_REF: "refs/heads/master",
      GITHUB_SHA: manifest.source_commit,
      GITHUB_TOKEN: "fixture-token"
    };
    expect(validateReleaseEnvironment(environment, channel, manifest.source_commit)).toBe("fixture-token");
    expect(() => validateReleaseEnvironment({ ...environment, GITHUB_SHA: "c".repeat(40) }, channel, manifest.source_commit))
      .toThrow(/differs from the admitted artifact/u);
    expect(() => validateReleaseEnvironment({ ...environment, GITHUB_ACTIONS: "false" }, channel, manifest.source_commit))
      .toThrow(/protected manual/u);
    expect(() => validateWorkflowEnvelope({})).toThrow(/protected manual/u);
  });

  test("the unsigned beta warning names the Windows action and exact installer checksum", () => {
    const beta = buildReleasePresentation(manifest, {
      releaseTier: "unsigned-beta",
      installNotice: UNSIGNED_BETA_INSTALL_NOTICE
    });
    expect(beta.name).toContain("unsigned beta");
    expect(beta.body).toContain("More info → Run anyway");
    expect(beta.body).toContain(manifest.installer.sha256);
    expect(beta.body).toContain("do not run it");
  });

  test("the updater URL names the final tag rather than GitHub's temporary draft alias", () => {
    const draftAlias = "https://github.com/owner/repo/releases/download/untagged-123/setup.exe";
    const canonical = canonicalGitHubAssetUrl("owner/repo", "v416.1.2", "setup.exe");
    expect(canonical).toBe("https://github.com/owner/repo/releases/download/v416.1.2/setup.exe");
    expect(canonical).not.toBe(draftAlias);
    expect(() => canonicalGitHubAssetUrl("owner/repo", "v416.1.2", "../setup.exe")).toThrow(/invalid/u);
  });

  test("the artifact source must be clean and the exact public branch head", () => {
    const channel = validateReleaseChannel({
      schema_version: 1,
      kind: "hivemind-github-release-channel",
      repository: "owner/repo",
      branch: "master",
      api_origin: "https://api.github.com",
      remote_url: "https://github.com/owner/repo.git"
    });
    const responses = new Map([
      ["rev-parse HEAD", `${manifest.source_commit}\n`],
      ["diff --quiet", ""],
      ["diff --cached --quiet", ""],
      ["ls-files --others --exclude-standard -z", ""],
      ["remote get-url origin", "https://github.com/owner/repo.git\n"],
      ["ls-remote origin refs/heads/master", `${manifest.source_commit}\trefs/heads/master\n`]
    ]);
    const runGit = (args: string[]) => responses.get(args.join(" ")) ?? "";
    expect(() => assertCurrentReleaseSource(manifest.source_commit, channel, runGit)).not.toThrow();
    responses.set("ls-remote origin refs/heads/master", `${"c".repeat(40)}\trefs/heads/master\n`);
    expect(() => assertCurrentReleaseSource(manifest.source_commit, channel, runGit)).toThrow(/exact public release branch head/u);
    responses.set("ls-remote origin refs/heads/master", `${manifest.source_commit}\trefs/heads/master\n`);
    responses.set("ls-files --others --exclude-standard -z", "untracked\0");
    expect(() => assertCurrentReleaseSource(manifest.source_commit, channel, runGit)).toThrow(/source is dirty/u);
  });
});

function descriptor(uploaded: Map<string, { url: string }>) {
  return { installer: uploaded.get("installer")?.url };
}

function fakeApi(options: {
  failUpload?: string;
  ambiguousPublish?: boolean;
  latestMismatch?: boolean;
  existing?: Record<string, unknown>;
} = {}) {
  const state = {
    events: [] as string[],
    deleted: false,
    release: {
      id: 42,
      draft: true,
      tag_name: "v416.1.2",
      target_commitish: manifest.source_commit,
      name: "",
      body: "",
      upload_url: "https://uploads.github.test/release{?name,label}",
      assets: [] as Array<Record<string, unknown>>
    }
  };
  return {
    state,
    api: {
      async listReleases() { state.events.push("list"); return options.existing ? [options.existing] : []; },
      async tagExists() { state.events.push("tag"); return false; },
      async createDraft(input: { name: string; body: string }) {
        state.events.push("draft");
        state.release.name = input.name;
        state.release.body = input.body;
        return state.release;
      },
      async uploadAsset(_url: string, asset: { name: string; bytes: Buffer }) {
        state.events.push(`upload:${asset.name}`);
        if (asset.name === options.failUpload) throw new Error(`upload failed: ${asset.name}`);
        const uploaded = {
          id: state.release.assets.length + 1,
          name: asset.name,
          size: asset.bytes.length,
          state: "uploaded",
          url: `https://api.github.test/assets/${state.release.assets.length + 1}`,
          browser_download_url: `https://github.test/download/${asset.name}`
        };
        state.release.assets.push(uploaded);
        return uploaded;
      },
      async getRelease() { state.events.push("get"); return state.release; },
      async getLatestRelease() {
        state.events.push("latest");
        return options.latestMismatch ? { ...state.release, id: 99 } : state.release;
      },
      async updateRelease(_id: number, update: { draft: boolean }) {
        if (update.draft === false) {
          state.events.push("publish");
          state.release.draft = false;
          if (options.ambiguousPublish) throw new Error("connection lost after publish");
        } else {
          state.events.push("withdraw");
          state.release.draft = true;
        }
        return state.release;
      },
      async deleteRelease() { state.events.push("delete"); state.deleted = true; }
    }
  };
}
