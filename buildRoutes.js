// buildRoutes.js
//
// Exposes:
//   POST /api/build/start          multipart: zip file + projectName
//   GET  /api/build/status/:id
//   GET  /api/build/download/:id
//
// No Firebase auth here — simplified version. If you set BUILD_API_KEY
// as an env var, requests must send it as `x-api-key` header, otherwise
// the routes are open (fine for personal/small-scale use).

const express = require('express');
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const { pushZipToBuildBranch, startCodemagicBuild, waitForCodemagicBuild, fetchApkFromBuild, deleteBuildBranch } = require('./codemagicBuilder');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// buildId -> { status, message, error, apkPath, projectName, createdAt,
//              logs: string[] }
// `logs` accumulates every log line seen across the whole build (queue
// -> Codemagic build steps) so the client can request everything from
// index 0, or just the tail — see the `since` query param below.
const builds = new Map();

function checkApiKey(req, res, next) {
  const required = process.env.BUILD_API_KEY;
  if (!required) return next(); // no key configured -> open access
  const provided = req.headers['x-api-key'];
  if (provided !== required) return res.status(401).json({ error: 'Invalid or missing API key.' });
  next();
}

router.post('/api/build/start', checkApiKey, upload.single('zip'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No zip file uploaded.' });

  const buildId = uuidv4();
  builds.set(buildId, {
    status: 'queued',
    message: 'Queued',
    projectName: req.body?.projectName || 'app',
    createdAt: Date.now(),
    logs: ['Queued'],
  });

  // Fire-and-forget — the app polls /status for progress.
  runBuildAsync(buildId, req.file.buffer).catch((e) => {
    const prev = builds.get(buildId) || {};
    const logs = prev.logs || [];
    builds.set(buildId, { ...prev, status: 'error', error: e.message, logs: [...logs, `Error: ${e.message}`] });
  });

  res.json({ buildId });
});

router.get('/api/build/status/:buildId', checkApiKey, (req, res) => {
  const entry = builds.get(req.params.buildId);
  if (!entry) return res.status(404).json({ error: 'Build not found.' });
  const { status, message, error, downloadUrl, logs } = entry;

  // `since` lets the client ask for only the log lines it hasn't seen
  // yet (its own current logs.length) instead of re-downloading the
  // whole growing array every 3-second poll. Missing/invalid `since`
  // just returns everything from the start.
  const allLogs = logs || [];
  const since = Number.parseInt(req.query.since, 10);
  const fromIndex = Number.isFinite(since) && since >= 0 ? since : 0;
  const newLogs = allLogs.slice(fromIndex);

  res.json({ status, message, error, downloadUrl, logs: newLogs, logCount: allLogs.length });
});

router.get('/api/build/download/:buildId', checkApiKey, (req, res) => {
  const entry = builds.get(req.params.buildId);
  if (!entry) return res.status(404).json({ error: 'Build not found.' });
  if (entry.status !== 'done' || !entry.apkPath) {
    return res.status(409).json({ error: 'Build is not finished yet.' });
  }
  res.download(entry.apkPath, `${entry.projectName || 'app'}.apk`, (err) => {
    if (!err) {
      fs.unlink(entry.apkPath, () => {});
    }
  });
});

async function runBuildAsync(buildId, zipBuffer) {
  const update = (status, message) => {
    const prev = builds.get(buildId) || {};
    const logs = prev.logs || [];
    // Only append a fresh log line when the message actually changed —
    // avoids spamming the same "Building…" line every poll cycle while
    // Codemagic sits in one status for a while.
    const lastLine = logs[logs.length - 1];
    const nextLogs = message && message !== lastLine ? [...logs, message] : logs;
    builds.set(buildId, { ...prev, status, message, logs: nextLogs });
  };

  const appendLogLines = (lines) => {
    if (!lines || lines.length === 0) return;
    const prev = builds.get(buildId) || {};
    const logs = prev.logs || [];
    builds.set(buildId, { ...prev, logs: [...logs, ...lines] });
  };

  update('pushing', 'Pushing code to build repo…');
  const { projectType } = await pushZipToBuildBranch(zipBuffer, buildId);

  update('queued', `Starting Codemagic build (${projectType})…`);
  const cmBuildId = await startCodemagicBuild(buildId, projectType);

  const finishedBuild = await waitForCodemagicBuild(cmBuildId, {
    onUpdate: (coarseState, codemagicStatus, newStepLines) => {
      update(coarseState, `Codemagic: ${codemagicStatus}`);
      appendLogLines(newStepLines);
    },
  });

  update('packaging', 'Downloading built APK from Codemagic…');
  const apkBytes = await fetchApkFromBuild(finishedBuild);

  const apkPath = path.join(os.tmpdir(), `coderit-build-${buildId}.apk`);
  fs.writeFileSync(apkPath, apkBytes);

  const prev = builds.get(buildId) || {};
  const logs = prev.logs || [];
  builds.set(buildId, {
    ...prev,
    status: 'done',
    message: 'Done',
    logs: [...logs, 'Done'],
    apkPath,
    downloadUrl: `${process.env.PUBLIC_BASE_URL}/api/build/download/${buildId}`,
  });

  deleteBuildBranch(buildId); // best-effort, don't block the response on it
}

module.exports = router;
