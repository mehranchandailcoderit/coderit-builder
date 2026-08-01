// codemagicBuilder.js
//
// Replaces githubBuilder.js — same job (push the user's generated
// project somewhere buildable, kick off a build, poll until it's
// done, hand back the APK bytes) but driven by Codemagic's free
// Hobby tier instead of GitHub Actions.
//
// Codemagic's API can't accept a zip directly — it only builds an
// existing branch/tag on a Git repo it already has access to. So the
// push-to-a-throwaway-branch step from githubBuilder.js is kept
// as-is (same GitHub Contents API dance), and Codemagic is layered
// on top just for the "build it and hand back status/artifact" part:
//
//   1. Push the uploaded zip to `build/<buildId>` on the shared
//      builder repo (same helper as before).
//   2. POST /builds to Codemagic with that branch — this fires a
//      build using whatever workflow is configured in the app's
//      codemagic.yaml on the builder repo.
//   3. Poll GET /builds/:id until status is finished/failed —
//      Codemagic returns a `buildActions` array (one entry per step
//      of the workflow, each with its own status) that maps neatly
//      onto the CoderIT progress stepper, and an `artefacts` array
//      with a direct, already-authenticated download URL once done.
//   4. Download the .apk from that URL.
//   5. Delete the throwaway branch (best-effort, same as before).
//
// Needs: axios (already a dependency), plus everything
// pushZipToBuildBranch/deleteBuildBranch already needed.

const axios = require('axios');

const GITHUB_API = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_BUILD_TOKEN; // same fine-grained PAT as before, Contents RW only now — Actions RW no longer needed
const GITHUB_REPO = process.env.GITHUB_BUILDER_REPO; // e.g. "mehranchandail/coderit-builder"
const BASE_BRANCH = process.env.GITHUB_BUILDER_BASE_BRANCH || 'main';

const CODEMAGIC_API = 'https://api.codemagic.io';
const CODEMAGIC_TOKEN = process.env.CODEMAGIC_API_TOKEN;
const CODEMAGIC_APP_ID = process.env.CODEMAGIC_APP_ID;
// Optional — only needed if the builder repo's codemagic.yaml defines
// more than one workflow and the default (first) one isn't the right
// one. Leave unset to let Codemagic use the app's default workflow...
// actually Codemagic's API requires a workflowId, so this one is
// effectively required; documented clearly in the README.
const CODEMAGIC_WORKFLOW_ID = process.env.CODEMAGIC_WORKFLOW_ID;

function assertGithubConfigured() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    throw new Error(
      'GITHUB_BUILD_TOKEN / GITHUB_BUILDER_REPO not set on the server. See README.md.'
    );
  }
}

function assertCodemagicConfigured() {
  if (!CODEMAGIC_TOKEN || !CODEMAGIC_APP_ID || !CODEMAGIC_WORKFLOW_ID) {
    throw new Error(
      'CODEMAGIC_API_TOKEN / CODEMAGIC_APP_ID / CODEMAGIC_WORKFLOW_ID not set on the server. See README.md.'
    );
  }
}

const gh = () =>
  axios.create({
    baseURL: GITHUB_API,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

const cm = () =>
  axios.create({
    baseURL: CODEMAGIC_API,
    headers: {
      'x-auth-token': CODEMAGIC_TOKEN,
      'Content-Type': 'application/json',
    },
  });

/**
 * Pushes every file in `zipBuffer` to a new branch `build/<buildId>` on
 * the builder repo. Identical to the old githubBuilder.js version —
 * Codemagic still needs the code to live on a real Git branch it can
 * clone, same as GitHub Actions did.
 */
async function pushZipToBuildBranch(zipBuffer, buildId) {
  assertGithubConfigured();
  const AdmZip = require('adm-zip');
  const api = gh();
  const [owner, repo] = GITHUB_REPO.split('/');

  const { data: baseRef } = await api.get(`/repos/${owner}/${repo}/git/ref/heads/${BASE_BRANCH}`);
  const baseCommitSha = baseRef.object.sha;
  const { data: baseCommit } = await api.get(`/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);

  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length === 0) throw new Error('Uploaded zip has no files.');

  const treeEntries = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY);
    const blobs = await Promise.all(
      batch.map(async (entry) => {
        const { data } = await api.post(`/repos/${owner}/${repo}/git/blobs`, {
          content: entry.getData().toString('base64'),
          encoding: 'base64',
        });
        return { path: entry.entryName, sha: data.sha };
      })
    );
    for (const b of blobs) {
      treeEntries.push({ path: b.path, mode: '100644', type: 'blob', sha: b.sha });
    }
  }

  const { data: tree } = await api.post(`/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: treeEntries,
  });

  const { data: commit } = await api.post(`/repos/${owner}/${repo}/git/commits`, {
    message: `CoderIT build ${buildId}`,
    tree: tree.sha,
    parents: [baseCommitSha],
  });

  await api.post(`/repos/${owner}/${repo}/git/refs`, {
    ref: `refs/heads/build/${buildId}`,
    sha: commit.sha,
  });

  return commit.sha;
}

/**
 * Kicks off a Codemagic build for the `build/<buildId>` branch and
 * returns Codemagic's own build id (different from CoderIT's buildId —
 * needed for every subsequent status/artifact call).
 */
async function startCodemagicBuild(buildId) {
  assertCodemagicConfigured();
  const api = cm();
  const { data } = await api.post('/builds', {
    appId: CODEMAGIC_APP_ID,
    workflowId: CODEMAGIC_WORKFLOW_ID,
    branch: `build/${buildId}`,
  });
  if (!data.buildId) throw new Error('Codemagic did not return a buildId when starting the build.');
  return data.buildId;
}

/**
 * One poll of Codemagic's build status. Maps Codemagic's `status` and
 * per-step `buildActions` onto the same coarse states CoderIT's UI
 * already understands (queued/building/packaging/done/error), and
 * separately hands back the raw `buildActions` array so the caller can
 * turn it into log-line chips without CoderIT needing to know
 * Codemagic's step-naming conventions up front.
 */
async function fetchCodemagicStatus(cmBuildId) {
  const api = cm();
  const { data } = await api.get(`/builds/${cmBuildId}`);
  return data.build;
}

/** Codemagic's raw `status` values, mapped to CoderIT's coarse states. */
function coarseStateFromCodemagicStatus(status) {
  switch (status) {
    case 'queued':
    case 'preparing':
    case 'fetching':
      return 'queued';
    case 'building':
    case 'testing':
      return 'building';
    case 'publishing':
      return 'packaging';
    case 'finished':
      return 'done';
    case 'failed':
    case 'canceled':
    case 'timeout':
    case 'skipped':
      return 'error';
    default:
      return 'building'; // unrecognized-but-in-progress status — keep the stepper moving rather than erroring out
  }
}

/**
 * Turns Codemagic's `buildActions` array into short human-readable
 * lines, one per action whose status changed — the closest thing to
 * "build log lines" this API exposes without scraping the live log
 * viewer. Each action looks like `{ name, status, ... }`; not every
 * field is documented, so this reads defensively.
 */
function logLinesFromBuildActions(buildActions) {
  if (!Array.isArray(buildActions)) return [];
  return buildActions
    .filter((a) => a && a.name)
    .map((a) => `${a.name}: ${a.status || 'pending'}`);
}

/**
 * Polls Codemagic until the build finishes (success or failure).
 * `onUpdate(coarseStatus, message, logLines)` is called every poll
 * cycle so the caller (buildRoutes.js) can push progress into its own
 * `builds` map the same way it did for the GitHub Actions path.
 */
async function waitForCodemagicBuild(cmBuildId, { onUpdate } = {}) {
  let lastActionsSignature = '';

  while (true) {
    await sleep(5000);
    const build = await fetchCodemagicStatus(cmBuildId);
    const coarseState = coarseStateFromCodemagicStatus(build.status);
    const lines = logLinesFromBuildActions(build.buildActions);

    // Only surface a log update when something about the steps
    // actually changed since the last poll, so the client isn't
    // re-sent an identical chip list every 5 seconds.
    const signature = lines.join('|');
    if (signature !== lastActionsSignature) {
      lastActionsSignature = signature;
      onUpdate?.(coarseState, build.status, lines);
    } else {
      onUpdate?.(coarseState, build.status, null);
    }

    if (coarseState === 'done') return build;
    if (coarseState === 'error') {
      throw new Error(
        `Build failed on Codemagic (status: ${build.status}). ` +
          `See https://codemagic.io/app/${CODEMAGIC_APP_ID}/build/${cmBuildId}`
      );
    }
  }
}

/**
 * Downloads the .apk from the finished build's artefacts list.
 * Codemagic's artifact URLs already include auth in the path itself
 * (see Artifacts API docs) — a plain GET with the x-auth-token header
 * works directly, no separate public-URL exchange needed since this
 * download happens server-side, not from the Flutter app.
 */
async function fetchApkFromBuild(build) {
  const artefacts = build.artefacts || [];
  const apkArtifact =
    artefacts.find((a) => (a.type || '').toLowerCase() === 'apk') ||
    artefacts.find((a) => (a.name || '').toLowerCase().endsWith('.apk'));
  if (!apkArtifact || !apkArtifact.url) {
    throw new Error('Codemagic build finished but no .apk artifact was found.');
  }

  const resp = await axios.get(apkArtifact.url, {
    headers: { 'x-auth-token': CODEMAGIC_TOKEN },
    responseType: 'arraybuffer',
  });
  return Buffer.from(resp.data);
}

/** Deletes the throwaway build branch. Best-effort — never throws. */
async function deleteBuildBranch(buildId) {
  try {
    const api = gh();
    const [owner, repo] = GITHUB_REPO.split('/');
    await api.delete(`/repos/${owner}/${repo}/git/refs/heads/build/${buildId}`);
  } catch (_) {
    // Non-fatal — a stray branch can be cleaned up manually later.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  pushZipToBuildBranch,
  startCodemagicBuild,
  waitForCodemagicBuild,
  fetchApkFromBuild,
  deleteBuildBranch,
};
