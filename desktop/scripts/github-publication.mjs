const API_VERSION = "2022-11-28";

export function validateReleaseChannel(channel) {
  if (channel?.schema_version !== 1 || channel?.kind !== "hivemind-github-release-channel" ||
      typeof channel.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(channel.repository) ||
      typeof channel.branch !== "string" || !/^[A-Za-z0-9._/-]+$/u.test(channel.branch) ||
      channel.api_origin !== "https://api.github.com" ||
      channel.remote_url !== `https://github.com/${channel.repository}.git`) {
    throw new Error("release channel configuration is invalid");
  }
  return channel;
}

export function validateReleaseEnvironment(environment, channel, sourceCommit, releaseTier = "production") {
  validateWorkflowEnvelope(environment, releaseTier);
  const token = environment.GITHUB_TOKEN;
  if (environment.GITHUB_REPOSITORY !== channel.repository || environment.GITHUB_REF !== `refs/heads/${channel.branch}` ||
      environment.GITHUB_SHA !== sourceCommit) {
    throw new Error("release workflow repository, branch, or commit differs from the admitted artifact");
  }
  if (typeof token !== "string" || token.trim() === "") throw new Error("GITHUB_TOKEN is unavailable");
  return token;
}

export function validateWorkflowEnvelope(environment, releaseTier = "production") {
  if (environment.GITHUB_ACTIONS !== "true" || environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
      environment.HIVEMIND_PUBLIC_RELEASE_APPROVED !== "true" ||
      environment.HIVEMIND_RELEASE_TIER !== releaseTier) {
    throw new Error("public release requires the protected manual GitHub Actions workflow");
  }
}

export function assertCurrentReleaseSource(sourceCommit, channel, runGit) {
  if (runGit(["rev-parse", "HEAD"]).trim() !== sourceCommit) {
    throw new Error("HEAD differs from the admitted artifact source");
  }
  runGit(["diff", "--quiet"]);
  runGit(["diff", "--cached", "--quiet"]);
  if (runGit(["ls-files", "--others", "--exclude-standard", "-z"]) !== "") {
    throw new Error("release source is dirty");
  }
  const remote = runGit(["remote", "get-url", "origin"]).trim().replace(/\/$/u, "");
  if (`${remote}.git`.replace(/\.git\.git$/u, ".git") !== channel.remote_url) {
    throw new Error("origin does not match the configured public release repository");
  }
  const remoteLine = runGit(["ls-remote", "origin", `refs/heads/${channel.branch}`]).trim();
  if (remoteLine !== `${sourceCommit}\trefs/heads/${channel.branch}`) {
    throw new Error("the admitted source commit is not the exact public release branch head");
  }
}

export function createGitHubApi({ channel, token, fetchImpl = fetch }) {
  validateReleaseChannel(channel);
  const [owner, repository] = channel.repository.split("/");
  const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;

  async function requestJson(method, pathname, body, expected = [200]) {
    const url = apiUrl(pathname);
    const response = await fetchImpl(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "Hivemind-Release-Publisher",
        "X-GitHub-Api-Version": API_VERSION
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error"
    });
    if (!expected.includes(response.status)) throw new Error(`GitHub ${method} ${pathname} returned HTTP ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  }

  function apiUrl(pathname) {
    const url = new URL(pathname, channel.api_origin);
    if (url.origin !== channel.api_origin) throw new Error("GitHub API request escaped the configured origin");
    return url;
  }

  return {
    async listReleases() {
      const releases = await requestJson("GET", `${basePath}/releases?per_page=100`, undefined, [200]);
      if (!Array.isArray(releases)) throw new Error("GitHub release listing was not an array");
      return releases;
    },
    async tagExists(tag) {
      const response = await fetchImpl(apiUrl(`${basePath}/git/ref/tags/${encodeURIComponent(tag)}`), {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "Hivemind-Release-Publisher",
          "X-GitHub-Api-Version": API_VERSION
        },
        redirect: "error"
      });
      if (response.status === 404) return false;
      if (response.status !== 200) throw new Error(`GitHub tag lookup returned HTTP ${response.status}`);
      return true;
    },
    createDraft(input) {
      return requestJson("POST", `${basePath}/releases`, {
        tag_name: input.tag,
        target_commitish: input.sourceCommit,
        name: input.name,
        body: input.body,
        draft: true,
        prerelease: false,
        generate_release_notes: false,
        make_latest: "false"
      }, [201]);
    },
    getRelease(id) {
      return requestJson("GET", `${basePath}/releases/${id}`, undefined, [200]);
    },
    getLatestRelease() {
      return requestJson("GET", `${basePath}/releases/latest`, undefined, [200]);
    },
    updateRelease(id, body) {
      return requestJson("PATCH", `${basePath}/releases/${id}`, body, [200]);
    },
    async deleteRelease(id) {
      await requestJson("DELETE", `${basePath}/releases/${id}`, undefined, [204]);
    },
    async uploadAsset(uploadTemplate, asset) {
      const template = uploadTemplate.replace("{?name,label}", "");
      const url = new URL(template);
      if (url.origin !== "https://uploads.github.com" ||
          url.pathname !== `${basePath}/releases/${asset.releaseId}/assets`) {
        throw new Error("GitHub upload URL does not belong to the admitted release");
      }
      url.searchParams.set("name", asset.name);
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": asset.contentType,
          "Content-Length": String(asset.bytes.length),
          "User-Agent": "Hivemind-Release-Publisher",
          "X-GitHub-Api-Version": API_VERSION
        },
        body: asset.bytes,
        redirect: "error"
      });
      if (response.status !== 201) throw new Error(`GitHub asset upload returned HTTP ${response.status}: ${asset.name}`);
      return response.json();
    },
    authorizedFetch(url, options = {}) {
      const parsed = new URL(url);
      const headers = new Headers(options.headers);
      if (parsed.origin === channel.api_origin) {
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("X-GitHub-Api-Version", API_VERSION);
      }
      return fetchImpl(url, { ...options, headers });
    }
  };
}

export function buildReleasePresentation(manifest, { releaseTier, installNotice } = {}) {
  const source = `Source: ${manifest.source_commit}`;
  if (releaseTier === "unsigned-beta") {
    if (typeof installNotice !== "string" || installNotice.trim() === "") {
      throw new Error("unsigned beta release presentation requires an install notice");
    }
    return {
      name: `Hivemind ${manifest.version} — unsigned beta`,
      body: [
        "## Windows beta install notice",
        "",
        installNotice,
        "",
        `Installer SHA-256: \`${manifest.installer.sha256}\``,
        "",
        `Immutable Windows x64 artifact: \`${manifest.artifact_id}\``,
        source
      ].join("\n")
    };
  }
  if (releaseTier !== "production") throw new Error("release presentation has an unsupported tier");
  return {
    name: `Hivemind ${manifest.version}`,
    body: `Immutable Windows x64 artifact ${manifest.artifact_id}\n\n${source}`
  };
}

export async function publishDraftTransaction({ api, manifest, assets, buildDescriptor, verifyDraft, presentation }) {
  validatePresentation(presentation);
  const tag = `v${manifest.version}`;
  const releases = await api.listReleases();
  const sameTag = releases.filter((release) => release?.tag_name === tag);
  if (sameTag.some((release) => release.draft !== true)) {
    throw new Error(`release tag ${tag} is already public and will never be reused`);
  }
  for (const draft of sameTag) {
    if (draft.target_commitish !== manifest.source_commit) {
      throw new Error(`existing draft ${tag} belongs to another source commit`);
    }
    await api.deleteRelease(draft.id);
  }
  if (await api.tagExists(tag)) throw new Error(`release tag ${tag} already exists and will never be reused`);

  const draft = await api.createDraft({
    tag,
    sourceCommit: manifest.source_commit,
    name: presentation.name,
    body: presentation.body
  });
  assertDraft(draft, tag, manifest.source_commit, presentation);
  let expectedAssets;
  try {
    const uploaded = new Map();
    for (const asset of assets) {
      const result = await api.uploadAsset(draft.upload_url, { ...asset, releaseId: draft.id });
      assertUploadedAsset(result, asset);
      uploaded.set(asset.role, result);
    }
    const descriptor = buildDescriptor(uploaded);
    const descriptorAsset = {
      role: "candidate",
      name: "release-candidate.json",
      contentType: "application/json",
      bytes: Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
    };
    const uploadedDescriptor = await api.uploadAsset(draft.upload_url, { ...descriptorAsset, releaseId: draft.id });
    assertUploadedAsset(uploadedDescriptor, descriptorAsset);
    expectedAssets = [...assets, descriptorAsset];

    await verifyDraft(uploadedDescriptor.url);
    assertRelease(await api.getRelease(draft.id), { draft: true, tag, sourceCommit: manifest.source_commit, assets: expectedAssets, presentation });

    const published = await api.updateRelease(draft.id, { draft: false, prerelease: false, make_latest: "true" });
    assertRelease(published, { draft: false, tag, sourceCommit: manifest.source_commit, assets: expectedAssets, presentation });
    assertRelease(await api.getRelease(draft.id), { draft: false, tag, sourceCommit: manifest.source_commit, assets: expectedAssets, presentation });
    const latest = await api.getLatestRelease();
    if (latest?.id !== draft.id) throw new Error("GitHub latest release is not the verified immutable candidate");
    assertRelease(latest, { draft: false, tag, sourceCommit: manifest.source_commit, assets: expectedAssets, presentation });
    return { release_id: draft.id, tag_name: tag, artifact_id: manifest.artifact_id };
  } catch (error) {
    await recoverFailedPublication(api, draft.id);
    throw error;
  }
}

function validatePresentation(presentation) {
  if (typeof presentation?.name !== "string" || presentation.name.trim() === "" ||
      typeof presentation?.body !== "string" || presentation.body.trim() === "") {
    throw new Error("release presentation is incomplete");
  }
}

function assertDraft(release, tag, sourceCommit, presentation) {
  if (!Number.isSafeInteger(release?.id) || release.draft !== true || release.tag_name !== tag ||
      release.target_commitish !== sourceCommit || release.name !== presentation.name ||
      release.body !== presentation.body || typeof release.upload_url !== "string") {
    throw new Error("GitHub did not create the exact requested draft release");
  }
}

function assertUploadedAsset(result, expected) {
  if (!Number.isSafeInteger(result?.id) || result.name !== expected.name || result.size !== expected.bytes.length ||
      result.state !== "uploaded" || typeof result.url !== "string" || typeof result.browser_download_url !== "string") {
    throw new Error(`GitHub did not retain the exact uploaded asset: ${expected.name}`);
  }
}

function assertRelease(release, expected) {
  const actualAssets = Array.isArray(release?.assets) ? release.assets : [];
  const expectedByName = new Map(expected.assets.map((asset) => [asset.name, asset.bytes.length]));
  const actualByName = new Map(actualAssets.map((asset) => [asset.name, asset.size]));
  const exactAssets = expectedByName.size === actualByName.size &&
    [...expectedByName].every(([name, size]) => actualByName.get(name) === size);
  if (release?.draft !== expected.draft || release.tag_name !== expected.tag ||
      release.target_commitish !== expected.sourceCommit ||
      release.name !== expected.presentation.name || release.body !== expected.presentation.body || !exactAssets) {
    throw new Error("GitHub release state differs from the verified immutable candidate");
  }
}

async function recoverFailedPublication(api, releaseId) {
  let observed;
  try {
    observed = await api.getRelease(releaseId);
  } catch (inspectionError) {
    throw new Error("release publication failed and GitHub state could not be inspected", { cause: inspectionError });
  }
  if (observed.draft === true) {
    await api.deleteRelease(releaseId);
    return;
  }
  try {
    const withdrawn = await api.updateRelease(releaseId, { draft: true, prerelease: false, make_latest: "false" });
    if (withdrawn?.draft !== true) throw new Error("GitHub did not return the release to draft state");
  } catch (withdrawError) {
    throw new Error("release publication failed and the public candidate could not be withdrawn", { cause: withdrawError });
  }
}
