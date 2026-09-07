declare const __dirname: string;

const SEP = __dirname.includes('\\') ? '\\' : '/';
const nodeFs = jest.requireActual('fs') as {
  readFileSync(path: string, encoding: string): string;
};

function readSheetSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'cron-job-sheet.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readSectionSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'components', 'activity', 'cron-section.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readGatewayProviderSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'context', 'gateway-provider.tsx'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readManifestClientSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'lib', 'gateway', 'manifest-client.ts'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readAdaptersSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'lib', 'portal', 'adapters.ts'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readRpcRoutesSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'src', 'lib', 'gateway', 'rpc-routes.ts'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readHermesBackendSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'gate', 'core', 'cli-environments', 'backends', 'hermes.mjs'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readGatewayMethodsSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'gate', 'core', 'capabilities', 'gateway-methods.mjs'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

function readServerSource(): string {
  return nodeFs
    .readFileSync(
      [__dirname, '..', 'gate', 'core', 'server.mjs'].join(SEP),
      'utf8',
    )
    .replace(/\r\n/g, '\n');
}

describe('cron job sheet remove', () => {
  test('the sheet exposes a Remove button gated on !acting beside Run now and Pause/Resume', () => {
    // The cron job sheet was read/control only: Run now + Pause/Resume.
    // Remove is the destructive counterpart to those two, sits in the same
    // control row, gated on !acting so the three never overlap an inflight
    // request, and opens a ConfirmSheet that confirms into botJobs.remove.
    const src = readSheetSource();
    expect(src).toMatch(/import\s+\{[^}]*\bConfirmSheet\b[^}]*\}\s+from\s+['"]@\/components\/ui['"]/);

    // The Remove button is in the same controls row as Run now and Pause/Resume.
    expect(src).toMatch(/label=\{acting \? 'Working…' : 'Run now'\}/);
    expect(src).toMatch(/cronJobPauseLabel\(\{ paused \}\)/);
    expect(src).toMatch(/label="Remove"/);

    // The button is disabled while acting, so a confirmed remove never races
    // with an inflight Run or Pause.
    const removeButton = src.match(/<Button\s+label="Remove"[\s\S]*?\/>/)?.[0];
    expect(removeButton).toBeDefined();
    expect(removeButton).toMatch(/disabled=\{acting\}/);

    // The button arms removeTarget with the open jobId, never with a bare
    // literal — a fresh sheet mount without jobId would otherwise confirm a
    // destructive action into the void.
    expect(removeButton).toMatch(/onPress=\{\(\) => jobId && setRemoveTarget\(jobId\)\}/);
  });

  test('a confirmed remove fires botJobs.remove with a snapshotted target', () => {
    // A fast Cancel after Confirm must still remove the job the user
    // tapped — the executeRemove closure snapshots removeTarget into a
    // local before awaiting so the race never coerces into "remove null".
    const src = readSheetSource();
    const fn = src.match(/const executeRemove = useCallback\(async \(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toMatch(/const target = removeTarget \?\? jobId;/);
    expect(fn).toMatch(/await botJobs\.remove\(target\);/);
    // The catch surfaces the refusal through the same control-error path
    // Run now and Pause/Resume already use, then clears the pending target.
    expect(fn).toMatch(/setControlError\(describeCronJobControlError\(caught\)\)/);
    expect(fn).toMatch(/catch[\s\S]*?setRemoveTarget\(null\)/);
  });

  test('the ConfirmSheet uses destructive semantics with a "Remove" confirm', () => {
    const src = readSheetSource();
    const sheet = src.match(/<ConfirmSheet[\s\S]*?\/>/)?.[0];
    expect(sheet).toBeDefined();
    expect(sheet).toMatch(/danger/);
    expect(sheet).toMatch(/confirmLabel="Remove"/);
    expect(sheet).toMatch(/title="Remove scheduled job\?"/);
    // The sheet only renders when the user has armed a target.
    expect(sheet).toMatch(/visible=\{removeTarget !== null\}/);
    expect(sheet).toMatch(/onCancel=\{\(\) => setRemoveTarget\(null\)\}/);
    expect(sheet).toMatch(/onConfirm=\{\(\) => void executeRemove\(\)\}/);
  });

  test('a successful remove fires onRemoved so the parent re-reads the cron list', () => {
    // The cron-section owns the cron list. The sheet can only close the
    // sheet; it cannot drop a row from its parent's list. The onRemoved
    // callback is the parent-side hook that lets the cron roster reflect
    // the deletion without remounting the sheet's parent.
    const src = readSheetSource();
    const fn = src.match(/const executeRemove = useCallback\(async \(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0];
    expect(fn).toMatch(/onRemoved\?\.\(\)/);
    // And the parent wires it to a cron-section load.
    const section = readSectionSource();
    expect(section).toMatch(/onRemoved=\{\(\) =>/);
    expect(section).toMatch(/setOpenJob\(null\)/);
    expect(section).toMatch(/void load\(\)/);
  });

  test('botJobs.remove is exposed by the provider with the same client guard shape as run/pause', () => {
    // The provider exposes run/pause with a `if (!client?.method) throw` guard;
    // remove follows the same pattern so a backend without removeJob fails
    // honestly instead of crashing deeper in the call.
    const src = readGatewayProviderSource();
    expect(src).toMatch(/remove:\s*async\s*\(jobId: string\) =>\s*\{/);
    expect(src).toMatch(/if \(!client\?\.removeJob\)\s*throw\s*new Error\(['"]This gateway does not remove jobs\.['"]\)/);
    expect(src).toMatch(/await client\.removeJob\(jobId\)/);
    // The botJobs context type includes remove.
    expect(src).toMatch(/remove:\s*\(jobId: string\)\s*=>\s*Promise<void>/);
  });

  test('ManifestClient.removeJob mirrors setJobPaused with a DELETE request', () => {
    // The client method is the same shape as setJobPaused (withBotOnly +
    // URL-encoded jobId + bot-scoped body when applicable) so the request
    // hits the Gate's DELETE /v1/jobs/{id} route with the same auth/bot
    // headers as every other job call.
    const src = readManifestClientSource();
    expect(src).toMatch(/async removeJob\(jobId: string\):\s*Promise<void>/);
    // The function body must contain: this.requireEndpoint('jobs'), a
    // 'DELETE' method, this.withBotOnly(template), the jobId URL encode,
    // and the botId-aware body — same five pieces setJobPaused carries.
    const fnIdx = src.indexOf('async removeJob(');
    const fnEnd = src.indexOf('\n  }', fnIdx);
    const fn = src.slice(fnIdx, fnEnd + 1);
    expect(fn).toContain("this.requireEndpoint('jobs')");
    expect(fn).toContain("'DELETE'");
    expect(fn).toContain('this.withBotOnly(');
    expect(fn).toContain('encodeURIComponent(jobId)');
    expect(fn).toContain('this.botId ? { bot: this.botId } : {}');
    // Same trailing-slash strip pattern setJobPaused uses: source has the
    // regex `/\\/+$/` (regex literal escaped forward-slash). Assert it is
    // present by checking for the body of the regex literal itself.
    expect(fn).toMatch(/path\.replace\(\/\\\/\+\$\//);
  });

  test('the PortalClient interface advertises removeJob as an optional method', () => {
    // Every other job method on PortalClient is optional (`?`), so a backend
    // without removeJob is still a valid client and the provider's guard
    // is the only failure path — matching the run/pause contract.
    const src = readAdaptersSource();
    expect(src).toMatch(/removeJob\?\(jobId: string\):\s*Promise<void>/);
  });

  test("rpc-routes maps 'jobs.remove' to DELETE /api/jobs/{jobId}", () => {
    // The slash-command path falls through gatewayRequest('jobs.remove', { jobId })
    // and resolveRoute needs a method/path entry to land on the Hermes backend's
    // DELETE endpoint — no entry means the route resolves to null and the
    // caller surfaces the METHOD_GUIDANCE refusal instead of a 404.
    const src = readRpcRoutesSource();
    expect(src).toMatch(/'jobs\.remove':\s*\{\s*method:\s*'DELETE',\s*path:\s*'\/api\/jobs\/\{jobId\}'\s*\}/);
  });

  test("gateway-methods dispatches 'jobs.remove' to removeJob on the resolved backend", () => {
    // The Gate's RPC dispatch for jobs.remove is a one-liner that hands the
    // jobId to the backend's removeJob — same shape as jobs.run / jobs.pause.
    const src = readGatewayMethodsSource();
    expect(src).toMatch(/'jobs\.remove':\s*\(params\)\s*=>\s*via\(getBackend,\s*params,\s*'removeJob',\s*\(b\)\s*=>\s*b\.removeJob\(jobIdOf\(params\)\)\)/);
  });

  test('the Hermes backend posts DELETE /api/jobs/{id} mirroring deleteSession', () => {
    // The Hermes backend answers the cron remove with the same call shape
    // it already uses for deleteSession: call(path, { method: 'DELETE' }),
    // no body, the bare /api/jobs/{id} URL.
    const src = readHermesBackendSource();
    expect(src).toMatch(/async removeJob\(jobId\)\s*\{[\s\S]*?await call\(`\/api\/jobs\/\$\{encodeURIComponent\(jobId\)\}`,\s*\{\s*method:\s*'DELETE'\s*\}\);[\s\S]*?\}/);
  });

  test('the Gate allowlist and DELETE handler reach removeJob on the backend', () => {
    // Two pieces: (1) the allowlist permits DELETE /v1/jobs/{id} so the
    // request isn't bounced as 404, and (2) the handler dispatches to
    // removeJob on the resolved backend, with the same requireBackendMethod
    // guard the run/pause handler uses.
    const src = readServerSource();
    // Allowlist clause — must be after the run/pause/resume clause so
    // those POST routes still match first.
    expect(src).toContain("(method === 'DELETE' && /");
    expect(src).toContain('/v1\\/jobs\\/[^/]+$/');
    // Handler block — mirrors the jobActionMatch block shape.
    expect(src).toContain('const jobDeleteMatch = pathname.match(/^\\/v1\\/jobs\\/([^/]+)$/);');
    expect(src).toContain("method === 'DELETE'");
    expect(src).toContain("requireBackendMethod(backend, 'removeJob')");
    expect(src).toContain('backend.removeJob(jobId)');
    expect(src).toContain('JSON.stringify({ ok: true })');
  });

  test('Run now and Pause/Resume stay byte-identical alongside the new Remove button', () => {
    // The two existing controls are pinned so a future change that touches
    // one of them cannot silently rewrite the other. Run now: label,
    // disabled binding, onPress to submitRun. Pause/Resume: label via
    // cronJobPauseLabel, disabled binding, onPress to submitTogglePause.
    const src = readSheetSource();
    expect(src).toMatch(/label=\{acting \? 'Working…' : 'Run now'\}/);
    expect(src).toMatch(/onPress=\{\(\) => void submitRun\(\)\}/);
    expect(src).toMatch(/label=\{cronJobPauseLabel\(\{ paused \}\)\}/);
    expect(src).toMatch(/onPress=\{\(\) => void submitTogglePause\(\)\}/);
    // submitTogglePause still toggles pausedOverride only on the success
    // path, never in the catch — a refused Pause never flips the label.
    const toggle = src.match(/const submitTogglePause = useCallback\(async \(\) => \{[\s\S]*?\}, \[[\s\S]*?\]\);/)?.[0];
    expect(toggle).toMatch(/setPausedOverride\(!paused\)/);
    expect(toggle).toMatch(/catch[\s\S]*?setControlError\(describeCronJobControlError\(caught\)\)/);
  });
});
